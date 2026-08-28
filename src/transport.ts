export function resolveMcpStatelessSetting(value: string | undefined): boolean {
    if (value === undefined || value === "" || value === "false") return false;
    if (value === "true") return true;
    throw new Error("MCP_STATELESS must be 'true' or 'false'.");
}
