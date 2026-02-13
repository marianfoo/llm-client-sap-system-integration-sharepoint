# LibreChat SAP + SharePoint Enterprise Template

Complete setup guide — from overview to verified deployment.

---

## Table of Contents

1. [What This Template Does](#1-what-this-template-does)
2. [What You Get](#2-what-you-get)
3. [Prerequisites](#3-prerequisites)
4. [Setup: Entra ID (Authentication)](#4-setup-entra-id-authentication)
5. [Setup: SharePoint File Picker](#5-setup-sharepoint-file-picker)
6. [Setup: SAP MCP Servers](#6-setup-sap-mcp-servers)
7. [Configuration Files](#7-configuration-files)
8. [Deployment](#8-deployment)
9. [Agent Curation (Admin)](#9-agent-curation-admin)
10. [Verification Checklist](#10-verification-checklist)
11. [Security Posture](#11-security-posture)
12. [Troubleshooting](#12-troubleshooting)
13. [References](#13-references)

---

## 1. What This Template Does

This is a fork of [LibreChat](https://github.com/danny-avila/LibreChat) configured as an enterprise template for organizations that use **SAP** and **Microsoft 365**. It combines:

- **AI chat** with multiple LLM providers (OpenAI, Anthropic, Azure, etc.)
- **Microsoft Entra ID** as the sole authentication method
- **SharePoint file picker** for attaching documents directly from SharePoint/OneDrive into chat
- **SAP MCP servers** for AI-assisted SAP development and documentation access
- **Curated agents** with controlled tool access to SAP systems

The template is designed for DEV/staging environments with a clear path to production hardening.

## 2. What You Get

### Authentication

- Entra ID (OpenID Connect) as the only login method
- On-Behalf-Of (OBO) token exchange for downstream API access (SharePoint, Graph)
- Server-side session storage for federated tokens

### SharePoint Integration

- Native SharePoint file picker in the chat attach menu
- Pick and attach files from SharePoint sites and OneDrive
- Supported formats: `docx`, `xlsx`, `pptx`, `csv`, `md`, `txt` (up to 25 MB)
- No SharePoint MCP server, no indexing/RAG — attachment-only access

### SAP Integration (via MCP)

Three Model Context Protocol (MCP) servers:

| Server | Purpose | Chat menu |
|--------|---------|-----------|
| `abap-community-docs` | ABAP community documentation search | Yes |
| `sap-docs` | Official SAP documentation search | Yes |
| `sap-dev-adt` (VSP) | Read-only SAP DEV system access via ADT | Agent-only |

### Governance

- Users cannot create or share MCP servers
- Agent builder is disabled for regular users
- SAP DEV tools are exposed only through curated agents with an approved tool allowlist
- SAP DEV container applies outbound network lock rules (egress to SAP host only)

---

## 3. Prerequisites

- [Git](https://git-scm.com/downloads)
- [Docker](https://www.docker.com/products/docker-desktop/) (includes Docker Compose)
- Access to an **Azure / Entra ID** tenant (to create an app registration)
- A **SharePoint Online** tenant
- A **SAP DEV** system with a technical user (for MCP access)

---

## 4. Setup: Entra ID (Authentication)

Entra ID is the sole login method. This section walks through the Azure Portal configuration.

### 4.1 Decide your callback URLs

LibreChat constructs the redirect URL as `${DOMAIN_SERVER}${OPENID_CALLBACK_URL}`.

| Environment | `DOMAIN_SERVER` | Entra redirect URI |
|-------------|----------------|-------------------|
| Local/dev | `http://localhost:3080` | `http://localhost:3080/oauth/openid/callback` |
| Production | `https://<your-domain>` | `https://<your-domain>/oauth/openid/callback` |

### 4.2 Create an Entra app registration

In the [Entra admin center](https://entra.microsoft.com/):

1. Go to **Identity** > **Applications** > **App registrations** > **New registration**.
2. Set:
   - **Name**: e.g. `LibreChat (DEV)`
   - **Supported account types**: Single tenant (recommended)
   - **Redirect URI**: Platform `Web`, URL `http://localhost:3080/oauth/openid/callback`
3. Click **Register**.
4. Capture the **Application (client) ID** and **Directory (tenant) ID**.

### 4.3 Configure Authentication

In your app registration > **Authentication**:

1. Ensure a **Web** platform is configured.
2. Add all redirect URIs (dev + prod) you will use.

### 4.4 Create a client secret

In your app registration > **Certificates & secrets**:

1. Create **New client secret**.
2. **Copy the secret value immediately** — it is shown only once.

> **Common mistake:** Copying the "Secret ID" (a UUID) instead of the "Secret Value" (the actual secret string). Use the **Value** column.

### 4.5 Expose an API (required for OBO / SharePoint)

The On-Behalf-Of flow requires that Entra issues an access token with **your app's audience** (not the default `https://graph.microsoft.com`). Without this, the OBO assertion is rejected with `AADSTS50013`.

In your app registration > **Expose an API**:

1. Click **Set** next to **Application ID URI** — accept the default `api://<client-id>`.
2. Click **Add a scope**:
   - **Scope name**: `user_impersonation`
   - **Who can consent**: Admins and users
   - **Admin consent display name**: `Access LibreChat on behalf of the user`
   - **State**: Enabled
3. Under **Authorized client applications**, click **Add a client application**:
   - **Client ID**: your own app's client ID (same as `OPENID_CLIENT_ID`)
   - Check the `user_impersonation` scope

### 4.6 Add API permissions

In your app registration > **API permissions**:

1. Add **Microsoft Graph** > Delegated > `Files.Read.All`
2. Add **Office 365 SharePoint Online** > Delegated > `AllSites.Read`
   - (Search for "SharePoint" under "APIs my organization uses")
3. Click **Grant admin consent for \<your tenant\>**

### 4.7 Configure `.env` — Entra section

```env
ALLOW_EMAIL_LOGIN=false
ALLOW_REGISTRATION=false
ALLOW_SOCIAL_LOGIN=true
ALLOW_SOCIAL_REGISTRATION=true

DOMAIN_SERVER=http://localhost:3080

OPENID_CLIENT_ID=<app-client-id>
OPENID_CLIENT_SECRET=<app-client-secret-value>
OPENID_ISSUER=https://login.microsoftonline.com/<tenant-id>/v2.0
OPENID_SESSION_SECRET=<generate with: openssl rand -hex 32>
OPENID_CALLBACK_URL=/oauth/openid/callback
OPENID_REUSE_TOKENS=true

# Must match the Application ID URI from "Expose an API" (step 4.5)
OPENID_AUDIENCE=api://<app-client-id>

# Custom scope ensures Entra issues a token for YOUR app's audience
OPENID_SCOPE="openid profile email offline_access api://<app-client-id>/user_impersonation"
```

**Key notes:**

- `OPENID_ISSUER`: Use `https://login.microsoftonline.com/<tenant-id>/v2.0` (not the `.well-known` URL).
- `OPENID_SESSION_SECRET`: Not an Entra value — generate with `openssl rand -hex 32`.
- `OPENID_REUSE_TOKENS=true`: Required for the OBO flow (SharePoint file picker).
- `offline_access` in scope: Required for refresh tokens.

---

## 5. Setup: SharePoint File Picker

The SharePoint file picker uses an OBO token exchange to get a SharePoint-scoped token from the user's Entra session.

### 5.1 Prerequisites

Steps 4.5 and 4.6 above (Expose an API + API permissions) must be completed first.

### 5.2 Configure `.env` — SharePoint section

```env
ENABLE_SHAREPOINT_FILEPICKER=true

# NO trailing slash, NO ${VAR} interpolation — use literal URLs
SHAREPOINT_TENANT_URL=https://<your-tenant>.sharepoint.com
SHAREPOINT_BASE_URL=https://<your-tenant>.sharepoint.com

# Scopes for the OBO token exchange
SHAREPOINT_PICKER_SHAREPOINT_SCOPE=https://<your-tenant>.sharepoint.com/AllSites.Read
SHAREPOINT_PICKER_GRAPH_SCOPE=Files.Read.All
```

> **Important:** Docker Compose `.env` files do **not** support `${VAR}` interpolation. Always use the literal URL. Using `SHAREPOINT_BASE_URL=${SHAREPOINT_TENANT_URL}` will cause a 404 in the file picker.

### 5.3 How it works

1. User logs in with Entra ID.
2. In chat, clicks **Attach** > **From SharePoint**.
3. LibreChat exchanges the user's access token (OBO flow) for a SharePoint-scoped token.
4. The SharePoint File Picker SDK (v8, iframe) loads and lets the user browse and select files.
5. Selected files are attached to the conversation.

### 5.4 Limits

- Max file size: 25 MB (configured in `librechat.enterprise.yaml`)
- Attachment-only — no SharePoint indexing, search, or RAG

---

## 6. Setup: SAP MCP Servers

### 6.1 Configure `.env` — SAP section

```env
SAP_TECH_USER=<technical-user>
SAP_TECH_PASSWORD=<technical-password>
SAP_URL=https://<sap-host>:<port>
SAP_CLIENT=001
SAP_INSECURE=true   # DEV only — see Security section
```

### 6.2 MCP server architecture

Three MCP servers run as Docker containers, defined in `docker-compose.override.yml` and configured in `config/librechat.enterprise.yaml`:

| Service | Container | Internal URL | Source |
|---------|-----------|-------------|--------|
| `abap-community-docs` | `abap-mcp` | `http://abap-mcp:3122/mcp` | `marianfoo/abap-community-docs-mcp` |
| `sap-docs` | `sap-docs-mcp` | `http://sap-docs-mcp:3122/mcp` | `marianfoo/sap-docs-mcp` |
| `sap-dev-adt` | `vsp-mcp` | `http://vsp-mcp:3000/mcp` | `oisee/vibing-steampunk` via `mcp-proxy` |

Images are built from local Dockerfiles under `docker/`.

### 6.3 MCP governance

Configured in `config/librechat.enterprise.yaml`:

```yaml
interface:
  mcpServers:
    use: true       # Users can use MCP tools
    create: false   # Users cannot add their own MCP servers
    share: false    # Users cannot share MCP configs

mcpSettings:
  allowedDomains:   # SSRF protection — only these internal hosts allowed
    - 'abap-mcp'
    - 'sap-docs-mcp'
    - 'vsp-mcp'
```

### 6.4 SAP authorization posture (Basis checklist)

The SAP technical user should have:

**Allow:**
- ADT repository read access
- Read table metadata and table contents (DEV)
- Read dumps/traces if diagnostics are required

**Deny:**
- Transports / CTS changes
- Object creation/change rights
- ABAP/report execution
- Activation and import/export

### 6.5 Network security

The `vsp-mcp` container runs with `NET_ADMIN` capability and applies iptables OUTPUT rules at startup, restricting outbound traffic to the resolved SAP DEV host/port only.

---

## 7. Configuration Files

| File | Purpose | Edit directly? |
|------|---------|---------------|
| `.env` | All credentials and feature flags | Yes |
| `config/librechat.enterprise.yaml` | LibreChat config (MCP servers, interface, agents) | Yes |
| `docker-compose.yml` | Upstream LibreChat compose file | **No** — kept unmodified |
| `docker-compose.override.yml` | Template customizations (local build, config mount, MCP services) | Yes |
| `deploy-compose.yml` | Alternative production split stack | Yes |

### Docker Compose override pattern

Docker Compose automatically merges `docker-compose.yml` + `docker-compose.override.yml`. This means:

- Upstream `docker-compose.yml` stays untouched — easier to pull upstream updates
- All template customizations are isolated in `docker-compose.override.yml`
- Override values take precedence over the base file

> **Note:** Upstream LibreChat has `docker-compose.override.yml` in `.gitignore`. This template removes it from `.gitignore` so the file is tracked in git — admins get the full setup when they clone.

### What the override adds

1. **Local build of the `api` image** — required for auth bug fixes (see [Code Changes](#code-changes-to-upstream-librechat))
2. **Config file mount** — `config/librechat.enterprise.yaml` → `/app/librechat.yaml`
3. **MCP service dependencies and definitions** — three SAP MCP containers

### `librechat.enterprise.yaml` overview

```yaml
version: 1.3.3
cache: true

interface:
  agents: true
  mcpServers:
    use: true
    create: false
    share: false

registration:
  socialLogins: ['openid']

mcpSettings:
  allowedDomains:
    - 'abap-mcp'
    - 'sap-docs-mcp'
    - 'vsp-mcp'

mcpServers:
  abap-community-docs:
    type: streamable-http
    url: 'http://abap-mcp:3122/mcp'
    chatMenu: true
  sap-docs:
    type: streamable-http
    url: 'http://sap-docs-mcp:3122/mcp'
    chatMenu: true
  sap-dev-adt:
    type: streamable-http
    url: 'http://vsp-mcp:3000/mcp'
    chatMenu: true

fileConfig:
  serverFileSizeLimit: 25

endpoints:
  agents:
    disableBuilder: true
```

---

## 8. Deployment

### 8.1 Clone and configure

```bash
git clone <this-repo-url>
cd LibreChat-MCP-Sharepoint
cp .env.example .env
```

Edit `.env` with your Entra, SharePoint, and SAP credentials (see sections 4, 5, 6 above).

Generate security secrets (or use https://www.librechat.ai/toolkit/creds_generator):

```bash
# Generate and paste into .env
openssl rand -hex 16   # CREDS_KEY
openssl rand -hex 8    # CREDS_IV
openssl rand -hex 32   # JWT_SECRET
openssl rand -hex 32   # JWT_REFRESH_SECRET
openssl rand -hex 32   # OPENID_SESSION_SECRET
```

### 8.2 Build and start

```bash
docker compose up -d --build
```

This reads `docker-compose.yml` + auto-merges `docker-compose.override.yml`, builds the `api` image locally (with auth fixes) and the MCP server images, then starts all services.

### 8.3 Verify startup

```bash
docker compose ps              # All containers should be running
docker compose logs -f api     # Watch API logs for errors
```

Open http://localhost:3080 and log in with Entra ID.

### 8.4 Updating

```bash
docker compose down
git pull
docker compose up -d --build
```

> Do **not** run `docker compose pull` for the `api` service — it's built locally. To pull other images: `docker compose pull mongodb meilisearch vectordb rag_api`

### 8.5 Production split stack

```bash
docker compose -f deploy-compose.yml -f docker-compose.override.yml up -d --build
```

### 8.6 Common commands

| Command | Purpose |
|---------|---------|
| `docker compose up -d --build` | Start/rebuild all services |
| `docker compose down` | Stop all services |
| `docker compose ps` | List running containers |
| `docker compose logs -f api` | Follow API logs |
| `docker compose logs api --since 5m` | Last 5 minutes of API logs |
| `docker compose restart api` | Restart API (picks up `.env` changes) |
| `docker compose build api` | Rebuild only the API image |
| `docker compose config --services` | Verify merged service list |

---

## 9. Agent Curation (Admin)

This template disables the agent builder for regular users. Agents are created by an admin, then the builder is re-locked.

### 9.1 Temporary unlock

Edit `config/librechat.enterprise.yaml`:

```yaml
interface:
  agents: true          # keep
endpoints:
  agents:
    disableBuilder: false   # temporarily set to false
```

Restart the stack: `docker compose restart api`

### 9.2 Create agents

**Agent 1: SAP Docs**

1. Open Agents panel as admin.
2. Create agent named `SAP Docs`.
3. Enable MCP servers: `abap-community-docs`, `sap-docs`.
4. Save and share to required users/roles.

**Agent 2: SAP DEV Read**

1. Create agent named `SAP DEV Read`.
2. Enable MCP server: `sap-dev-adt` only.
3. Enable **only** these tools:
   - `GetSource`
   - `SearchObject`, `GrepObjects`, `GrepPackages`
   - `GetPackage`, `GetFunctionGroup`
   - `GetTable`, `GetTableContents`
   - `GetCDSDependencies`
   - `GetSystemInfo`, `GetInstalledComponents`
   - `GetCallGraph`, `GetObjectStructure`
   - `GetDumps`, `GetDump`
   - `ListTraces`, `GetTrace`
   - `GetSQLTraceState`, `ListSQLTraces`
4. Save and share to required users/roles.

**Do not enable:** `RunQuery`, write/edit/import/export tools, reports, `ExecuteABAP`, transport/CTS tools, install tools, git tools, activation tools.

### 9.3 Re-lock

Revert `config/librechat.enterprise.yaml`:

```yaml
endpoints:
  agents:
    disableBuilder: true
```

Restart the stack: `docker compose restart api`

---

## 10. Verification Checklist

### 10.1 Stack health

```bash
docker compose ps                                    # All containers running
curl -fsS http://localhost:3123/health || true       # abap-mcp
curl -fsS http://localhost:3124/health || true       # sap-docs-mcp
curl -fsS http://localhost:3130/mcp || true          # vsp-mcp
```

### 10.2 UI checks

1. Login flow is Entra/OpenID only — no email/password form.
2. User cannot create or share MCP servers.
3. Agent builder is disabled for normal users.
4. Chat MCP menu shows docs servers.
5. `SAP DEV Read` agent is present and usable.
6. `SAP DEV Read` tools exclude `RunQuery` and write/transport/execute tools.

### 10.3 SharePoint checks

1. **Attach** > **From SharePoint** is visible.
2. File picker loads SharePoint content (no 404).
3. Pick and attach `docx`/`xlsx`/`pptx`/`csv`/`md`/`txt` files.
4. Model can quote or summarize attached content.

If SharePoint fails, check:

| Check | How to verify |
|-------|--------------|
| `OPENID_REUSE_TOKENS=true` | Check `.env` |
| `ENABLE_SHAREPOINT_FILEPICKER=true` | Check `.env` |
| `SHAREPOINT_BASE_URL` is a literal URL | No `${VAR}`, no trailing slash |
| `OPENID_AUDIENCE` is set | Must match Application ID URI (`api://<client-id>`) |
| `OPENID_SCOPE` includes custom scope | Must include `api://<client-id>/user_impersonation` |
| Entra "Expose an API" configured | Application ID URI, `user_impersonation` scope, authorized client |
| SharePoint permission added + consented | `AllSites.Read` with admin consent |
| User re-logged in after changes | Log out and back in for fresh tokens |
| API image built locally | Override uses `build: .`, not upstream `ghcr.io` image |

### 10.4 Common error codes

| Error | Meaning | Fix |
|-------|---------|-----|
| 404 in picker iframe | `SHAREPOINT_BASE_URL` is wrong | Use literal URL, no trailing slash |
| `AADSTS50013` | Wrong token audience | Configure "Expose an API", set `OPENID_AUDIENCE` |
| `AADSTS65001` | Missing admin consent | Add permission + grant admin consent |
| `AADSTS50011` | Redirect URI mismatch | Fix `DOMAIN_SERVER` / Entra redirect URI |
| 401 on all API calls | Auth cookie or token bug | Ensure API image is built locally |

---

## 11. Security Posture

This template is a **DEV baseline**. The following controls are enforced:

| Control | Implementation |
|---------|---------------|
| OpenID-only login | `.env` + `librechat.enterprise.yaml` |
| Token reuse for OBO flow | `OPENID_REUSE_TOKENS=true` |
| MCP server creation blocked | `interface.mcpServers.create: false` |
| MCP server sharing blocked | `interface.mcpServers.share: false` |
| Agent builder disabled | `endpoints.agents.disableBuilder: true` |
| SAP DEV via curated agents only | Tool allowlist in agent config |
| File upload size cap | `fileConfig.serverFileSizeLimit: 25` MB |
| SAP container egress lock | iptables OUTPUT rules to SAP host/port only |

### SAP TLS note

`SAP_INSECURE=true` disables TLS certificate validation — acceptable for DEV only.

**Production recommendations:**

1. Import and mount trusted CA certificates.
2. Set `SAP_INSECURE=false`.
3. Rotate technical credentials and store them in a secret manager.

### Out of scope

1. Entra group entitlement-based tool gating
2. SharePoint indexing/search/RAG
3. Per-user SAP credentials or SAP SSO
4. SAP production TLS hardening implementation
5. UI redesign

---

## 12. Troubleshooting

### Docker

| Issue | Fix |
|-------|-----|
| `UID`/`GID` warnings | Set in `.env` or ignore (defaults to root) |
| API container keeps restarting | `docker compose logs api --since 2m` |
| MCP services disconnecting | Normal on startup — wait 30s for reconnection |
| Config changes not taking effect | `docker compose restart api` for `.env`; `docker compose up -d --build` for code changes |

### Authentication

| Issue | Fix |
|-------|-----|
| Login redirect fails | Verify `DOMAIN_SERVER` matches Entra redirect URI exactly |
| `OPENID_CLIENT_SECRET` rejected | Use the **Secret Value**, not the Secret ID (UUID) |
| `JWT timestamp claim failed` | Stale browser session — clear cookies or use incognito |
| 401 on all API calls after login | Ensure API image is built locally with auth fixes |

### SharePoint

See error code table in [section 10.4](#104-common-error-codes).

---

## 13. References

### This template

| Document | Path |
|----------|------|
| Code changes vs upstream | `docs/code-changes.md` |
| Upstream issue draft | `docs/github-issue-draft.md` |

### Official LibreChat docs

- Docker install: https://www.librechat.ai/docs/local/docker
- Docker override: https://www.librechat.ai/docs/configuration/docker_override
- Remote Linux deployment: https://www.librechat.ai/docs/remote/docker_linux
- Environment variables: https://www.librechat.ai/docs/configuration/dotenv
- librechat.yaml config: https://www.librechat.ai/docs/configuration/librechat_yaml
- Authentication: https://www.librechat.ai/docs/configuration/authentication
- Azure Entra/AD: https://www.librechat.ai/docs/configuration/authentication/OAuth2-OIDC/azure
- Token reuse: https://www.librechat.ai/docs/configuration/authentication/OAuth2-OIDC/token-reuse
- SharePoint files: https://www.librechat.ai/docs/configuration/sharepoint
- MCP servers: https://www.librechat.ai/docs/features/mcp
- Agents: https://www.librechat.ai/docs/features/agents
- Credentials generator: https://www.librechat.ai/toolkit/creds_generator

### Microsoft (Entra / SharePoint)

- Register an app: https://learn.microsoft.com/en-us/entra/identity-platform/quickstart-register-app
- OpenID Connect protocol: https://learn.microsoft.com/en-us/entra/identity-platform/v2-protocols-oidc
- On-Behalf-Of flow: https://learn.microsoft.com/en-us/entra/identity-platform/v2-oauth2-on-behalf-of-flow
- Admin consent: https://learn.microsoft.com/en-us/entra/identity/enterprise-apps/grant-admin-consent
- Graph permissions reference: https://learn.microsoft.com/en-us/graph/permissions-reference

### Docker

- Docker Compose merge: https://docs.docker.com/compose/multiple-compose-files/merge/
- Multiple Compose files: https://docs.docker.com/compose/multiple-compose-files/extends/
