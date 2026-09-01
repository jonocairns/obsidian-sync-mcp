# CouchDB + MCP server — full self-contained deployment
# Uses the pre-built MCP server image from ghcr.io

# Required explicitly by Fly/setup and CI from deploy/mcp-image.env.
ARG MCP_IMAGE
FROM ${MCP_IMAGE} AS mcp

# Use CouchDB as base — has all CouchDB deps pre-installed
FROM couchdb:3@sha256:9ea24cbd76522fe845d1c32c7fd1dcfc8a3ba73dcc4817d62f8a7f7f1dfaffe3
LABEL org.opencontainers.image.source="https://github.com/jonocairns/obsidian-sync-mcp"
ARG MCP_IMAGE
LABEL mcp.image="${MCP_IMAGE}"

# Reuse the exact Node runtime from the reviewed MCP image. The pinned CouchDB
# image already provides curl for the supervisor/setup script.
COPY --from=mcp /usr/local/bin/node /usr/local/bin/node

# CouchDB config
COPY couchdb-init.ini /opt/couchdb/etc/local.d/livesync.ini

# MCP server (from published image)
WORKDIR /app
COPY --from=mcp /app/package.json package.json
COPY --from=mcp /app/node_modules/ node_modules/
COPY --from=mcp /app/dist/ dist/

# Startup
COPY entrypoint.sh /app/entrypoint.sh
RUN chmod +x /app/entrypoint.sh

EXPOSE 8787

HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
    CMD ["node", "-e", "const s=require('node:net').connect(8787,'127.0.0.1',()=>s.end());s.on('error',()=>process.exit(1));setTimeout(()=>process.exit(1),4000).unref()"]

ENTRYPOINT []
CMD ["/app/entrypoint.sh"]
