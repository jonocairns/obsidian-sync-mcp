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
    CMD ["node", "-e", "const s=require('node:net').connect(8787,'127.0.0.1',()=>s.end());s.on('error',()=>process.exit(1));setTimeout(()=>process.exit(1),4000).unref()"]

CMD ["node", "dist/main.js"]
