#!/bin/sh
set -eu

if [ -z "${SAP_URL:-}" ]; then
  echo "SAP_URL is required"
  exit 1
fi

SAP_SCHEME="$(echo "$SAP_URL" | sed -E 's#^(https?)://.*#\1#')"
SAP_TARGET="$(echo "$SAP_URL" | sed -E 's#^https?://##')"
SAP_HOST_PORT="$(echo "$SAP_TARGET" | cut -d/ -f1)"
SAP_PATH_RAW="$(echo "$SAP_TARGET" | cut -s -d/ -f2-)"
SAP_HOST="${SAP_HOST_PORT%%:*}"
SAP_PORT="${SAP_HOST_PORT##*:}"

if [ "$SAP_PORT" = "$SAP_HOST_PORT" ]; then
  if [ "$SAP_SCHEME" = "https" ]; then
    SAP_PORT=443
  else
    SAP_PORT=80
  fi
fi

if [ -n "${SAP_PATH_RAW}" ]; then
  SAP_PATH="/${SAP_PATH_RAW}"
else
  SAP_PATH=""
fi

SAP_IP="$(getent hosts "$SAP_HOST" | awk 'NR==1 {print $1}')"
if [ -z "$SAP_IP" ]; then
  echo "Could not resolve SAP host: $SAP_HOST"
  exit 1
fi

if [ "${VSP_EGRESS_LOCKDOWN:-true}" = "true" ]; then
  iptables -P OUTPUT DROP
  iptables -A OUTPUT -o lo -j ACCEPT
  iptables -A OUTPUT -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT
  iptables -A OUTPUT -p tcp -d "$SAP_IP" --dport "$SAP_PORT" -j ACCEPT
fi

export SAP_URL="${SAP_SCHEME}://${SAP_IP}:${SAP_PORT}${SAP_PATH}"

set -- vsp --url "$SAP_URL" --client "${SAP_CLIENT:-001}" --mode "${VSP_MODE:-focused}"

if [ -n "${SAP_USER:-}" ]; then
  set -- "$@" --user "$SAP_USER"
fi

if [ -n "${SAP_PASSWORD:-}" ]; then
  set -- "$@" --password "$SAP_PASSWORD"
fi

if [ "${SAP_INSECURE:-false}" = "true" ]; then
  set -- "$@" --insecure
fi

# Block all write operations by default; set SAP_READ_ONLY=false to allow writes
if [ "${SAP_READ_ONLY:-true}" = "true" ]; then
  set -- "$@" --read-only
fi

if [ -n "${VSP_EXTRA_ARGS:-}" ]; then
  # shellcheck disable=SC2086
  set -- "$@" ${VSP_EXTRA_ARGS}
fi

exec mcp-proxy --server stream --port "${MCP_PROXY_PORT:-3000}" -- "$@"
