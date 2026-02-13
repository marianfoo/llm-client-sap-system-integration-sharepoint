FROM node:22-bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends git ca-certificates \
  && rm -rf /var/lib/apt/lists/*

ARG ABAP_MCP_REPO=https://github.com/marianfoo/abap-mcp-server.git
ARG ABAP_MCP_REF=main

WORKDIR /opt
RUN git clone --depth 1 --branch ${ABAP_MCP_REF} ${ABAP_MCP_REPO} abap-mcp-server

WORKDIR /opt/abap-mcp-server
RUN npm ci \
  && npm run build --if-present

ENV MCP_HOST=0.0.0.0
ENV MCP_PORT=3122
ENV NODE_ENV=production

EXPOSE 3122

CMD ["npm", "run", "start:streamable"]
