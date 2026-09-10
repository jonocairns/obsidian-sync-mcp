import assert from "node:assert/strict";
import { test } from "node:test";
import * as applicationLogger from "octagonal-wheels/common/logger";
import * as commonlibLogger from "@vrtmrz/livesync-commonlib/compat/common/logger";
import { configureCommonlibLogging } from "./commonlib-logging.js";

test("Commonlib shares the application logger and never prints private paths", () => {
    assert.equal(commonlibLogger.Logger, applicationLogger.Logger);
    assert.equal(commonlibLogger.setGlobalLogFunction, applicationLogger.setGlobalLogFunction);
    const messages: unknown[][] = [];
    const original = console.log;
    console.log = (...args: unknown[]) => { messages.push(args); };
    try {
        configureCommonlibLogging(false);
        commonlibLogger.Logger("Private/synthetic-secret.md", commonlibLogger.LEVEL_INFO);
        assert.deepEqual(messages, []);
        configureCommonlibLogging(true);
        commonlibLogger.Logger("Private/synthetic-secret.md", commonlibLogger.LEVEL_INFO);
        assert.deepEqual(messages, [["[livesync] internal event (details redacted)"]]);
    } finally {
        configureCommonlibLogging(false);
        console.log = original;
    }
});
