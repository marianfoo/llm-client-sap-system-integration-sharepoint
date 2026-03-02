FROM node:22-bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends git ca-certificates \
  && rm -rf /var/lib/apt/lists/*

ARG SAP_DOCS_MCP_REPO=https://github.com/marianfoo/mcp-sap-docs.git
ARG SAP_DOCS_MCP_REF=main
# Offline mode: when true (default), search uses only local FTS index; no outbound calls to
# SAP Help, SAP Community, or Software Heroes. Set to false to enable online sources by default.
ARG SAP_DOCS_OFFLINE_MODE=true

WORKDIR /opt
RUN git clone --depth 1 --branch ${SAP_DOCS_MCP_REF} ${SAP_DOCS_MCP_REPO} mcp-sap-docs

WORKDIR /opt/mcp-sap-docs
RUN npm ci \
  && npm run setup --if-present \
  && npm run build --if-present \
  && sed -i "s/127\\.0\\.0\\.1/0.0.0.0/g" dist/src/streamable-http-server.js \
  # When offline mode is enabled, flip the in-code default so includeOnline is false unless
  # explicitly overridden per request. This keeps online search available when a caller passes
  # includeOnline=true, but offline results are returned without any extra parameter in every
  # ordinary search. When the upstream adds native MCP_INCLUDE_ONLINE_DEFAULT support this sed
  # can be removed and the env var alone will be sufficient.
  && if [ "${SAP_DOCS_OFFLINE_MODE}" = "true" ]; then \
       sed -i 's/includeOnline = true,/includeOnline = false,/' dist/src/lib/BaseServerHandler.js \
       && echo "sap-docs-mcp: offline mode enabled (includeOnline default=false)"; \
     else \
       echo "sap-docs-mcp: online mode enabled (includeOnline default=true)"; \
     fi

ENV MCP_HOST=0.0.0.0
ENV MCP_PORT=3122
ENV NODE_ENV=production
# Signals offline-only intent; consumed by the upstream once it adds env-var support for the default.
ENV MCP_INCLUDE_ONLINE_DEFAULT=false

EXPOSE 3122

CMD ["npm", "run", "start:streamable"]
