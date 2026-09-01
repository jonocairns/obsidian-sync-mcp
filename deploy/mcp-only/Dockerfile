# MCP server only — no CouchDB
# For Fly.io GitHub deploy and CLI deploy
# Pulls the pre-built image from ghcr.io

# Required explicitly by Fly/setup and CI from deploy/mcp-image.env.
ARG MCP_IMAGE
FROM ${MCP_IMAGE}

ENV NODE_ENV=production
ENV DATA_DIR=/data
USER root
RUN mkdir -p "${DATA_DIR}" && chown node:node "${DATA_DIR}"
USER node

EXPOSE 8787

HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
    CMD ["node", "--input-type=module", "--eval", "const response = await fetch('http://127.0.0.1:8787/health'); if (!response.ok) process.exit(1)"]

CMD ["node", "dist/main.js"]
