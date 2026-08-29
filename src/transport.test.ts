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

    it("rejects lower-level FastMCP switches that would override sessionful mode", () => {
        assert.throws(
            () => resolveMcpStatelessSetting("false", "true"),
            /Use MCP_STATELESS=true/,
        );
        assert.throws(
            () => resolveMcpStatelessSetting(undefined, undefined, ["--stateless", "true"]),
            /Use MCP_STATELESS=true/,
        );
    });

    it("allows redundant lower-level switches when stateless mode is enabled", () => {
        assert.equal(resolveMcpStatelessSetting("true", "true"), true);
        assert.equal(resolveMcpStatelessSetting("true", undefined, ["--stateless", "true"]), true);
    });
});
