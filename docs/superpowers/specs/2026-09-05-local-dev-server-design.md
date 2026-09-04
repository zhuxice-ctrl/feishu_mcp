# Local Development Server Design

## Purpose

Provide an owner-only MCP capability for starting and managing constrained local
development servers. The capability supports browser and device verification on
the host machine or its local network without exposing arbitrary shell execution.

The feature is designed for reuse across Node, Python, Android, and future
development environments. It must remain separate from short-lived build and
verification workflows.

## Scope

The MCP exposes one `local_dev_server` tool with these actions:

- `start`: validate a declared service and create a server session.
- `status`: return the state and connection details of one session.
- `list`: return the caller's active and recent sessions.
- `logs`: return bounded, redacted logs for one session.
- `stop`: terminate the session and all child processes.

`start` accepts a workspace identifier, declared service identifier, optional
permitted port, and a listener scope of `local` or `lan`. It returns a session
identifier, state, port, and the applicable local and LAN URLs.

## Security Boundaries

- Only the configured owner may use the tool.
- A service must belong to an approved workspace from the local workspace
  catalog; arbitrary paths are rejected.
- The caller selects a declared service, not an executable, command string, or
  arbitrary arguments.
- Each service declaration provides a closed command template, allowed runtime,
  permitted port range, listener policy, optional health path, and resource
  limits.
- `local` binds to `127.0.0.1`. `lan` must be explicitly requested and allowed
  by the declaration, then binds to `0.0.0.0`.
- Ports must be in the configured permitted range and checked before launch.
- The service is never automatically exposed through the production Cloudflare
  MCP hostname. LAN access only serves devices on the same local network.
- Logs are bounded and redacted with the existing task-log redaction policy.

## Runtime Adapters

The core coordinator is runtime-neutral. Runtime adapters translate a service
declaration into a closed process plan and health-check policy.

Initial adapters:

| Adapter | Allowed declared targets |
| --- | --- |
| Node | npm, pnpm, or yarn `dev`, `start`, and `preview` scripts |
| Python | declared Flask, Django, and FastAPI launch templates |
| Android | declared Gradle or ADB debug-service templates; missing SDK or emulator produces a typed environment error |
| Generic | administrator-declared closed command templates with enumerated parameters |

Adding an adapter must not alter the coordinator, session contract, authorization,
or process-cleanup code.

## Session Lifecycle

```text
requested -> validating -> starting -> running -> stopping -> stopped
                                  \-> failed
running -> expired
```

The coordinator validates the request and creates a session before spawning the
adapter's process. A session becomes `running` only after the declared health
check succeeds, or after its declared port is listening when no health check is
configured. The coordinator records redacted output continuously.

`stop`, expiration, MCP process shutdown, and an unexpected process exit all
terminate the full child-process tree. A failed start also performs this cleanup.
The session records a typed reason for port conflict, unavailable runtime,
unavailable Android environment, failed health check, process exit, timeout, or
explicit cancellation.

## Resource Controls

The implementation has explicit limits for concurrent sessions, session lifetime,
startup deadline, log size, and process output rate. Values are centrally
configured and validated at startup. Long-running server lifetime is distinct
from one-shot command timeout settings.

## Test and Release Topology

The production environment remains unchanged:

| Environment | Local port | Public endpoint | Tunnel and state |
| --- | ---: | --- | --- |
| Production | 3000 | `mcp.zxc66.asia` | Existing production Tunnel and production state |
| Test | 3001 | `mcp-test.zxc66.asia` | Independent Cloudflare Tunnel, credentials, token, data directory, and logs |

The test service runs from the feature branch with a dedicated `.env.test`.
It never shares task records, directory grants, approvals, or logs with the
production service. `mcp-test.zxc66.asia` is the long-lived validation entry.
ngrok is only a temporary fallback when the test Cloudflare path is unavailable.

Promotion requires test validation followed by merge and a separate production
restart. No test deployment modifies the production listener, hostname, token,
or running process.

## Acceptance Tests

- Owner can start, inspect, list, read logs for, and stop an allowed service.
- Non-owner, unknown workspace, disallowed service, arbitrary command, and
  unauthorized directory requests are rejected.
- Node, Python, Android, and generic adapters conform to the shared session
  contract; Android environment absence is reported without falling back to a
  shell.
- A `local` server is inaccessible through the LAN address; an explicitly
  permitted `lan` server is reachable on its declared LAN port.
- Port conflicts, startup failures, process crashes, health-check failures,
  expiry, cancellation, and MCP shutdown clean up child processes.
- Log redaction and bounded-output behavior are verified.
- Test and production configurations use different ports, credentials, state
  directories, and public hostnames.
