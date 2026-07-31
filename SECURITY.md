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



---

## Development automation security

### Owner-only scope

The nine development tools (`get_development_task`, `read_development_task_logs`,
`cancel_development_task`, `inspect_development_environment`,
`plan_environment_changes`, `apply_environment_plan`, `android_development`,
`windows_development`, `manage_development_project`) are restricted to the
configured owner identity. A non-owner caller receives `OWNER_REQUIRED` before
any toolchain, device, or filesystem action is taken. **Starting MCP as
administrator is unsupported** — the server runs as the owner user and elevates
only through the administrator broker for privileged environment changes.

### Trusted-toolchain exemption boundaries

Build, test, and package actions only execute toolchains resolved from `ready`
environment components in the reviewed catalog. The caller cannot supply a
template path, executable, command, URL, or free-form package-manager switch —
every input schema uses Zod `.strict()` to reject unknown fields. Host paths
require directory authorization; device paths forbid `/data`, `/system`,
`/proc`, and similar protected locations.

### Administrator broker — local-only design

The C# administrator broker communicates over a named pipe bound to
`127.0.0.1` with an HMAC-signed 64 KiB frame protocol. The 32-byte shared key
is generated with `RandomNumberGenerator` and ACL-protected to `SYSTEM` plus
the owner SID. The broker never listens on a network port, never reads the key
from disk per request, and never accepts unsolicited commands — every operation
is bound to a signed single-use plan.

### Single-use destructive approvals

Project creation, environment apply, device writes, signing, and process
execution require single-use exact approval: the signed request state binds the
tool, subject key, arguments digest, and nonce. A replayed or expired state is
rejected; an approved state is consumed immediately and cannot authorize a
second operation.

### Task-data protection

Task records, logs, and artifacts live under `DEV_TASK_DATA_DIR`, which must
remain inside `APPROVAL_DATA_DIR`. Directories are created with mode `0700`.
The management script (`manage-development-tasks.ps1`) prints only redacted
summaries (short id, tool, action, state, timestamps, byte size) and removes
only terminal task directories by verified UUID.

### Credential references

Signing credentials are referenced by opaque UUID, never by inline key
material. Android password credentials are DPAPI-protected under
`APPROVAL_DATA_DIR\credentials`. Windows entries contain only public alias and
thumbprint metadata for a code-signing certificate already installed with its
private key in `CurrentUser\My`; task-time signing never imports or decrypts a
PFX. Callers cannot select a PowerShell helper, executable, script, certificate
store, or SignTool argument.

### Package-script risk

Electron script execution only permits script names present in the current
manifest and re-reads the manifest plus lockfile digest before enqueueing to
detect drift. Shell-metacharacter script names are rejected at the schema level.

### Vulnerability-reporting checklist

Before reporting, confirm you have not included: Bearer tokens, PINs, approval
keys, broker keys, owner SIDs, device serials, full filesystem paths, task IDs,
certificate private data, or `.env` contents. Redact to category and object
identity only.
