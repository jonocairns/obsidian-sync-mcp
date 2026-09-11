/** Serialize asynchronous change handling; reconnect only from a handled sequence. */
export interface ChangeFeed<T> {
    on(event: "change", handler: (change: T) => void): unknown;
    on(event: "error" | "complete", handler: () => void): unknown;
    cancel(): void;
}

export function watchInOrder<T extends { seq: string | number }>(options: {
    since: string;
    open(since: string): ChangeFeed<T>;
    handle(change: T): Promise<void>;
    retryMs?: number;
}): () => Promise<void> {
    let since = options.since;
    let stopped = false;
    let feed: ChangeFeed<T> | undefined;
    let pending = Promise.resolve();
    let timer: ReturnType<typeof setTimeout> | undefined;

    const start = () => {
        if (stopped) return;
        let failed = false;
        let restarting = false;
        const restart = () => {
            if (stopped || restarting) return;
            restarting = true;
            feed?.cancel();
            // Already-emitted changes finish before reconnecting. If handling
            // failed, queued later changes are ignored and replayed on retry.
            void pending.then(() => {
                if (!stopped) timer = setTimeout(start, options.retryMs ?? 1000);
            });
        };
        try {
            feed = options.open(since);
            feed.on("change", (change) => {
                if (stopped || restarting) return;
                pending = pending.then(async () => {
                    if (stopped || failed) return;
                    await options.handle(change);
                    since = String(change.seq);
                }).catch(() => {
                    failed = true;
                    console.warn("CouchDB change handling failed; retrying from the last handled sequence (details redacted).");
                    restart();
                });
            });
            feed.on("error", restart);
            feed.on("complete", restart);
        } catch {
            restart();
        }
    };
    start();
    return async () => {
        stopped = true;
        clearTimeout(timer);
        feed?.cancel();
        await pending;
    };
}
