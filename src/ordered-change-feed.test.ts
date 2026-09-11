import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";
import { watchInOrder } from "./ordered-change-feed.js";

class Feed extends EventEmitter {
    cancelled = false;
    cancel() { this.cancelled = true; this.emit("complete"); }
}

test("change handling is ordered and close waits for the active handler", async () => {
    const feed = new Feed();
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const events: number[] = [];
    const stop = watchInOrder<{ seq: number }>({
        since: "0", open: () => feed,
        handle: async ({ seq }) => {
            events.push(seq);
            entered.resolve();
            await release.promise;
        },
    });
    feed.emit("change", { seq: 1 });
    feed.emit("change", { seq: 2 });
    await entered.promise;
    assert.deepEqual(events, [1]);
    const stopped = stop();
    release.resolve();
    await stopped;
    assert.deepEqual(events, [1], "queued changes must not run after close");
    assert.equal(feed.cancelled, true);
});

test("failed handlers replay from the last successful sequence before later changes", { timeout: 5000 }, async () => {
    const feeds: Feed[] = [];
    const sequences: string[] = [];
    const reconnected = Promise.withResolvers<void>();
    const done = Promise.withResolvers<void>();
    let fail = true;
    const handled: number[] = [];
    const stop = watchInOrder<{ seq: number }>({
        since: "0", retryMs: 1,
        open: (since) => {
            sequences.push(since);
            const feed = new Feed();
            feeds.push(feed);
            if (feeds.length === 2) reconnected.resolve();
            return feed;
        },
        handle: async ({ seq }) => {
            if (seq === 2 && fail) { fail = false; throw new Error("injected failure"); }
            handled.push(seq);
            if (seq === 3) done.resolve();
        },
    });
    try {
        for (const seq of [1, 2, 3]) feeds[0].emit("change", { seq });
        await reconnected.promise;
        assert.deepEqual(sequences, ["0", "1"]);
        assert.deepEqual(handled, [1]);
        for (const seq of [2, 3]) feeds[1].emit("change", { seq });
        await done.promise;
        assert.deepEqual(handled, [1, 2, 3]);
    } finally { await stop(); }
});

test("transport failure drains queued work before reconnect and close cancels retry", { timeout: 5000 }, async () => {
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const reconnected = Promise.withResolvers<void>();
    const feeds: Feed[] = [];
    const sequences: string[] = [];
    const stop = watchInOrder<{ seq: number }>({
        since: "0", retryMs: 1,
        open: (since) => {
            sequences.push(since);
            const feed = new Feed();
            feeds.push(feed);
            if (feeds.length === 2) reconnected.resolve();
            return feed;
        },
        handle: async () => { entered.resolve(); await release.promise; },
    });
    try {
        feeds[0].emit("change", { seq: 1 });
        await entered.promise;
        feeds[0].emit("error");
        assert.deepEqual(sequences, ["0"]);
        release.resolve();
        await reconnected.promise;
        assert.deepEqual(sequences, ["0", "1"]);
        feeds[1].emit("error");
    } finally { await stop(); }
    // Cross the retry deadline to prove close cannot reopen the feed.
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(feeds.length, 2);
});
