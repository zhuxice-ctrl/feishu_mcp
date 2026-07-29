# Security Policy

## Deployment warning

This project exposes local development tools over MCP. A public source repository does not
grant access to a running deployment, but a leaked deployment credential can expose every
directory authorized for that identity.

- Never commit `.env`, Bearer tokens, PINs, ngrok credentials, approval signing keys, logs,
  or persisted approval records.
- Treat `MCP_AUTH_TOKEN` as a root credential. Use at least 32 random bytes and rotate it
  immediately after suspected exposure.
- `x-aily-user` is an identity label, not a secret. Do not rely on it as the only access
  control for a public tunnel.
- Keep owner fallback disabled unless the MCP tool is private and bound to the intended
  owner deployment.
- Keep the approval data directory outside the repository.
- Review `git status` and run a secret scanner before every public release.

The fixed tunnel hostname is not an authentication credential. Publishing it makes the
endpoint discoverable, so transport authentication must remain enabled.

## Reporting a vulnerability

Do not publish credentials or exploit details in a public issue. Use the repository's
private GitHub security-advisory flow:

<https://github.com/zhuxice-ctrl/feishu_mcp/security/advisories/new>
