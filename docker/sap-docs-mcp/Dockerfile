FROM node:22-bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends git ca-certificates \
  && rm -rf /var/lib/apt/lists/*

ARG SAP_DOCS_MCP_REPO=https://github.com/marianfoo/mcp-sap-docs.git
ARG SAP_DOCS_MCP_REF=main

WORKDIR /opt
RUN git clone --depth 1 --branch ${SAP_DOCS_MCP_REF} ${SAP_DOCS_MCP_REPO} mcp-sap-docs

WORKDIR /opt/mcp-sap-docs
RUN npm ci \
  && npm run setup --if-present \
  && npm run build --if-present \
  && sed -i "s/127\\.0\\.0\\.1/0.0.0.0/g" dist/src/streamable-http-server.js

ENV MCP_HOST=0.0.0.0
ENV MCP_PORT=3122
ENV NODE_ENV=production

EXPOSE 3122

CMD ["npm", "run", "start:streamable"]
