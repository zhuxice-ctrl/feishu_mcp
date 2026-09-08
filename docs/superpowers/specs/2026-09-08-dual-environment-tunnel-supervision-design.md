# Dual environment tunnel supervision

## Goal

Keep the production and test MCP environments runnable at the same time without
requiring Windows startup services. Each environment remains resident after its
launcher starts and stops only when its own launcher receives Ctrl+C.

## Isolation model

The production and test launchers are separate supervisors. A supervisor owns
only processes it starts and uses an environment-specific tuple:

| Environment | Tunnel name | Local port | Metrics port | State file |
| --- | --- | ---: | ---: | --- |
| Production | feishu-mcp | 3000 | 20241 | production-state.json |
| Test | feishu-mcp-test | test-configured | test-configured | test-state.json |

The production launcher must never search for, stop, or reuse the test tunnel;
the inverse is also true. Existing externally managed processes are observed but
never adopted as children or terminated by another environment's launcher.

## Runtime behaviour

cf_mcp.bat starts the production supervisor in a visible terminal. The
supervisor starts a local MCP child only when production's port is unused, waits
for its health endpoint, then starts or observes only the matching production
cloudflared connector. It records a fresh state file atomically.

Every health interval, the supervisor verifies local health, cloudflared's
metrics endpoint, and public health. Temporary connector failures are restarted
with bounded backoff. A local MCP failure is surfaced clearly and ends that
production session. Ctrl+C stops only children started by that production
session, removes its own state file, and leaves test processes intact.

The test launcher follows the same protocol with its own values and state path.
No Windows service is installed or enabled for either environment.

## Failure handling

Stale state is removed before a new session claims an environment. A state file
whose recorded supervisor is gone never prevents a new supervisor from starting.
If the restart limit is reached, the supervisor exits with an actionable error
instead of silently leaving a stale state entry.

## Verification

Script-level tests verify the production/test identifiers are distinct and that
cleanup targets only matching process command lines. A manual concurrent check
starts production and test, verifies both local/public health endpoints, then
stops one and confirms the other remains healthy.
