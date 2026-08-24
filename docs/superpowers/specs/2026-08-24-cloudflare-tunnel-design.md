# Cloudflare Tunnel Migration Design (Checked Operational Contract)

## Goal

Replace the ngrok public transport with a Cloudflare named tunnel on a stable
self-owned hostname while preserving MCP authentication, host/origin checks,
and a reversible ngrok rollback path.

## Architecture (checked)

- The local MCP server lifecycle is decoupled from the public transport lifecycle.
- The server trusts a transport-neutral `PUBLIC_HOST`; `LEGACY_NGROK_DOMAIN`
  remains a temporary fallback for exactly one migration release.
- cloudflared owns the outbound connection to `127.0.0.1:PORT` and is supervised
  independently as a Windows service (`cloudflared`).
- The hostname, tunnel UUID, credential JSON, and Cloudflare login token stay
  outside the repository.
- `scripts/start-feishu-mcp.ps1` is local-service-only: it loads `.env`,
  validates `PUBLIC_HOST`, builds, starts `node dist/index.js`, and checks local
  `/health`. It no longer resolves ngrok, waits on port 4040, probes the public
  URL, or terminates a coupled tunnel process. On Q/Enter/Ctrl+C or node failure
  it cleans up only the local node process.
- `scripts/test-cloudflare-tunnel.ps1` is a bounded read-only health validator:
  exits 2/3 on local failure/invalid, 4/5 on public failure/invalid, 6/7 on
  missing/stopped cloudflared service, and 0 after `OK_CONNECTOR_CHECK`. It never
  prints Authorization, `MCP_AUTH_TOKEN`, `.env` contents, cloudflared
  credentials, or process environments.

## Configuration contract

```env
PUBLIC_HOST=mcp.example.com
# Keep NGROK_DOMAIN + NGROK_AUTHTOKEN only for rollback during the observation period.
```

`src/config.ts` exports:
- `NGROK_AUTHTOKEN` (documented key only; no server module uses it)
- `LEGACY_NGROK_DOMAIN = process.env.NGROK_DOMAIN || ""`
- `PUBLIC_HOST = process.env.PUBLIC_HOST || LEGACY_NGROK_DOMAIN`

`src/index.ts` builds `allowedRequestHosts` / `allowedOrigins` from
`localhost`, `127.0.0.1`, `[::1]`, `HOST`, and `PUBLIC_HOST`. Health endpoint and
MCP route are unchanged.

## External readiness checklist (operator)

1. Subdomain proxied in Cloudflare DNS (active zone).
2. `cloudflared tunnel login` and `cloudflared tunnel create feishu-mcp`.
3. `cloudflared tunnel route dns feishu-mcp mcp.example.com`.
4. `%USERPROFILE%\.cloudflared\config.yml` with `ingress` → `http://127.0.0.1:PORT`;
   NTFS ACL restricted to the service account.
5. `cloudflared service install`, service account set to the credential owner.
6. `.env` sets `PUBLIC_HOST=mcp.example.com`; restart the launch script.

## Cutover, observation, and rollback

- Validate first: `.\scripts\test-cloudflare-tunnel.ps1 -PublicHost mcp.example.com`.
- Switch Aily endpoint to `https://mcp.example.com/mcp`; preserve the existing
  Authorization header and `x-aily-user`; rediscover tools, ping, then one
  read-only authenticated tool.
- Observe for seven days; any public outage over five minutes without a known
  cause triggers a tested rollback: `Stop-Service cloudflared`, restore
  `NGROK_DOMAIN`/`NGROK_AUTHTOKEN` in `.env`, run `scripts/start-ngrok.ps1`,
  point Aily back at the old ngrok endpoint. Never delete the named tunnel or
  its DNS route during rollback.
- After successful observation, a separately approved cleanup removes the legacy
  `NGROK_DOMAIN` fallback and the ngrok launcher.

## Acceptance

- Local and public `/health` report version 1.0.0, exact 37-tool inventory, and
  `mcpEndpoint` equal to `/mcp`; `authEnabled` reflects the configured mode.
- `scripts/test-cloudflare-tunnel.ps1` distinguishes local, public, and service
  failures and exits nonzero for any of them.
- `launcher.test.mjs`, `startup-launcher.test.mjs`, `cloudflare-tunnel-script.test.mjs`,
  and `public-host-config.test.mjs` pass; full `npm test` is green.