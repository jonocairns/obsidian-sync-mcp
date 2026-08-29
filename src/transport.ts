export function resolveMcpStatelessSetting(
    value: string | undefined,
    fastMcpValue?: string,
    args: string[] = [],
): boolean {
    let stateless: boolean;
    if (value === undefined || value === "" || value === "false") {
        stateless = false;
    } else if (value === "true") {
        stateless = true;
    } else {
        throw new Error("MCP_STATELESS must be 'true' or 'false'.");
    }

    const statelessArgIndex = args.indexOf("--stateless");
    const fastMcpRequestsStateless = fastMcpValue === "true"
        || (statelessArgIndex !== -1 && args[statelessArgIndex + 1] === "true");
    if (!stateless && fastMcpRequestsStateless) {
        throw new Error(
            "Use MCP_STATELESS=true instead of FASTMCP_STATELESS=true or --stateless true.",
        );
    }

    return stateless;
}
