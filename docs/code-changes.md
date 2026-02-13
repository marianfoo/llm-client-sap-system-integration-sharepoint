# Code Changes to Upstream LibreChat

This document lists all modifications to upstream LibreChat source code in this fork, why they were needed, and what upstream issues they relate to.

These changes require building the `api` Docker image locally (not pulling from `ghcr.io`).

## Git structure / rebasing

All changes live on the `enterprise/entra-sharepoint` branch as isolated commits on top of upstream `main`. Each commit touches one logical concern, making rebases clean:

```bash
git fetch origin                # fetch latest upstream
git rebase origin/main          # replay our commits on top
```

| Commit | Files | Description |
|--------|-------|-------------|
| 1 | `AuthService.js` | `shouldUseSecureCookie()` + return `id_token` |
| 2 | `AuthController.js` | `federatedTokens` for OBO flow |
| 3 | `socialLogins.js`, `getLogStores.js` | OpenID session TTL = refresh token expiry |
| 4 | `config.js` | `SHAREPOINT_TENANT_URL` fallback |
| 5 | config, docs, docker, env | Enterprise template layer (no upstream source changes) |

If upstream fixes one of the bugs patched in commits 1-4, use `git rebase -i` and **drop** that commit.

## Summary

| File | Change | Bug/Feature |
|------|--------|-------------|
| `api/server/services/AuthService.js` | `shouldUseSecureCookie()` + return `id_token` | Auth bug fix |
| `api/server/controllers/AuthController.js` | Get access token from `federatedTokens` for OBO | SharePoint OBO fix |
| `api/server/socialLogins.js` | Session cookie maxAge follows `REFRESH_TOKEN_EXPIRY` | Session TTL fix |
| `api/cache/getLogStores.js` | Session-store TTL follows `REFRESH_TOKEN_EXPIRY` | Session TTL fix |
| `api/server/routes/config.js` | Add `SHAREPOINT_TENANT_URL` fallback | Config convenience |

---

## 1) `api/server/services/AuthService.js`

### Bug 1: Secure cookies on localhost (auth broken over HTTP)

**Problem:** `AuthService.js` uses `secure: isProduction` for all auth cookies. When running via Docker Compose, `NODE_ENV=production` is set by default. On `http://localhost:3080`, browsers silently drop `Secure` cookies — breaking all authenticated API calls (401 on every request after login).

**Context:** PR [#11518](https://github.com/danny-avila/LibreChat/pull/11518) already fixed this for session cookies in `api/server/socialLogins.js` by introducing `shouldUseSecureCookie()`, but `AuthService.js` was not updated.

**Fix:** Added the same `shouldUseSecureCookie()` helper to `AuthService.js` and replaced all 6 instances of `secure: isProduction` with `secure: shouldUseSecureCookie()`:

```javascript
function shouldUseSecureCookie() {
  const domainServer = process.env.DOMAIN_SERVER || '';
  let hostname = '';
  if (domainServer) {
    try {
      const normalized = /^https?:\/\//i.test(domainServer)
        ? domainServer
        : `http://${domainServer}`;
      const url = new URL(normalized);
      hostname = (url.hostname || '').toLowerCase();
    } catch {
      hostname = domainServer.toLowerCase();
    }
  }
  const isLocalhost =
    hostname === 'localhost' ||
    hostname === '127.0.0.1' ||
    hostname === '::1' ||
    hostname.endsWith('.localhost');
  return isProduction && !isLocalhost;
}
```

Affected cookies: `refreshToken`, `token_provider` (in `setAuthTokens`), `refreshToken`, `openid_access_token`, `token_provider`, `openid_user_id` (in `setOpenIDAuthTokens`).

### Bug 2: `access_token` vs `id_token` for app authentication

**Problem:** `setOpenIDAuthTokens()` returns `tokenset.access_token` as the app authentication token. With Entra ID v2.0, the `access_token` may be a Graph API token (audience `https://graph.microsoft.com`) that cannot be validated via JWKS by `openIdJwtStrategy`. The strategy expects an `id_token` (payload typed as `IDToken`).

**Context:** Same root cause as [issue #8796](https://github.com/danny-avila/LibreChat/issues/8796) (Auth0 encrypted access tokens). PR [#9931](https://github.com/danny-avila/LibreChat/pull/9931) added `OPENID_AUDIENCE` as a workaround but didn't fix the default behavior.

**Fix:** Return `id_token` with `access_token` fallback:

```javascript
const appAuthToken = tokenset.id_token || tokenset.access_token;
// ... use appAuthToken for cookie and return value
return appAuthToken;
```

The original `access_token` is preserved in `req.session.openidTokens.accessToken` for the OBO flow.

---

## 2) `api/server/controllers/AuthController.js`

### Fix: OBO flow needs the real access token, not the Bearer token

**Problem:** `graphTokenController` extracted the access token from the `Authorization: Bearer` header for the OBO flow. After Bug 2 fix above, the Bearer token is now the `id_token` (used for app auth via JWKS). The OBO flow requires the **original Entra ID access token** (with the app's audience), not the `id_token`.

**Fix:** Get the access token from `req.user.federatedTokens.access_token` instead of the Authorization header:

```diff
- const authHeader = req.headers.authorization;
- if (!authHeader || !authHeader.startsWith('Bearer ')) {
+ // The Bearer token in the Authorization header is the id_token
+ // used for app authentication via JWKS; the OBO flow requires the original access_token.
+ const accessToken = req.user.federatedTokens?.access_token;
+
+ if (!accessToken) {
    return res.status(401).json({
-     message: 'Valid authorization token required',
+     message: 'Entra ID access token not available — ensure OPENID_REUSE_TOKENS=true and re-login',
    });
  }
  // ...
- const accessToken = authHeader.substring(7);
  const tokenResponse = await getGraphApiToken(req.user, accessToken, scopes);
```

The `federatedTokens` object is populated by `openIdJwtStrategy` from the server-side session (stored in `req.session.openidTokens`).

---

## 3) `api/server/socialLogins.js` + `api/cache/getLogStores.js`

### Fix: OpenID session expires too quickly when OPENID_REUSE_TOKENS is enabled

**Problem:** With `OPENID_REUSE_TOKENS=true`, refresh tokens are stored server-side in the express-session. The session cookie `maxAge` and session-store TTL both used `SESSION_EXPIRY` (default ~15 minutes), causing users to be forced to re-authenticate frequently even though their refresh token was still valid for days.

**Fix in `socialLogins.js`:** When `OPENID_REUSE_TOKENS` is enabled, set the session cookie `maxAge` to `REFRESH_TOKEN_EXPIRY` instead of `SESSION_EXPIRY`:

```javascript
const openidSessionMaxAge = openidReuseTokens ? refreshTokenExpiry : sessionExpiry;
```

**Fix in `getLogStores.js`:** Pass `REFRESH_TOKEN_EXPIRY` (converted to seconds) as the TTL for `OPENID_SESSION` and `SAML_SESSION` cache stores:

```javascript
function getAuthSessionTtlSeconds() {
  const ttlMs = math(process.env.REFRESH_TOKEN_EXPIRY, DEFAULT_REFRESH_TOKEN_EXPIRY);
  return Math.ceil(ttlMs / 1000);
}

[CacheKeys.OPENID_SESSION]: sessionCache(CacheKeys.OPENID_SESSION, authSessionTtlSeconds),
[CacheKeys.SAML_SESSION]: sessionCache(CacheKeys.SAML_SESSION, authSessionTtlSeconds),
```

---

## 4) `api/server/routes/config.js`

### Enhancement: `SHAREPOINT_TENANT_URL` fallback

**Change:** The `sharePointBaseUrl` config value now falls back to `SHAREPOINT_TENANT_URL` if `SHAREPOINT_BASE_URL` is not set:

```javascript
sharePointBaseUrl: process.env.SHAREPOINT_BASE_URL || process.env.SHAREPOINT_TENANT_URL,
```

This was already in upstream for template convenience. No behavioral change — just documents that both env vars are accepted.

---

## Related upstream issues

| Reference | Relevance |
|-----------|-----------|
| **PR #11518** | Fixed `shouldUseSecureCookie()` in `socialLogins.js` but missed `AuthService.js` |
| **PR #11236** | Moved OpenID tokens to server-side sessions, kept `secure: isProduction` and `return access_token` |
| **PR #9931** | Added `OPENID_AUDIENCE` workaround, did not fix default `access_token` return |
| **Issue #8796** | Same root cause — Auth0 encrypted access tokens fail JWKS. Proposed `id_token` fix was not implemented |

See `docs/github-issue-draft.md` for the full upstream issue draft.

---

## Docker build requirement

Because these are source code changes to the `api` service, the Docker image must be built locally. This is configured in `docker-compose.override.yml` (not in the upstream `docker-compose.yml`):

```yaml
# docker-compose.override.yml
services:
  api:
    build:
      context: .
      dockerfile: Dockerfile
    image: librechat-mcp-sharepoint:local
```

Do **not** use the upstream `ghcr.io/danny-avila/librechat-dev:latest` image, as it does not contain these fixes.

The upstream `docker-compose.yml` is kept unmodified. All template customizations (local build, config mount, MCP services) live in `docker-compose.override.yml`, which Docker Compose auto-merges.

**Note:** Upstream LibreChat has `docker-compose.override.yml` in `.gitignore` (it's meant to be user-local). This template **removes** it from `.gitignore` so the override file is tracked in git — making setup easier for admins who clone the repo (no manual copy/rename step needed).
