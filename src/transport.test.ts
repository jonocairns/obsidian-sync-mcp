import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { resolveMcpStatelessSetting } from "./transport.js";

describe("resolveMcpStatelessSetting", () => {
    it("defaults to sessionful mode", () => {
        assert.equal(resolveMcpStatelessSetting(undefined), false);
        assert.equal(resolveMcpStatelessSetting(""), false);
        assert.equal(resolveMcpStatelessSetting("false"), false);
    });

    it("enables stateless mode explicitly", () => {
        assert.equal(resolveMcpStatelessSetting("true"), true);
    });

    it("rejects ambiguous values", () => {
        assert.throws(() => resolveMcpStatelessSetting("yes"), /MCP_STATELESS/);
    });
});
