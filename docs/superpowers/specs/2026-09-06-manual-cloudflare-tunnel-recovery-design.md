# Manual Cloudflare Tunnel Recovery Design

**Date:** 2026-09-06  
**Status:** Approved for planning  
**Scope:** The production MCP public connector only (`mcp.zxc66.asia`, local port 3000).

## Goal

Keep the existing manual `cf_mcp` launch workflow while making an active launch
self-healing when the Cloudflare connector loses its edge connections. The
solution must not install a Windows service, register a startup item, alter the
test connector, or expose credentials in code, logs, or diagnostics.

## Observed Failure

The production Node service remains healthy on loopback while its detached
`cloudflared` process can remain alive with zero active HA connections. Cloudflare
then serves error 1033 / HTTP 530. The current launcher only checks whether a
matching process exists; it cannot distinguish a healthy connector from this
false-alive state and does not restart it.

The production and test connectors have both been observed to lose connections
while traffic is routed through the local Mihomo TUN/fake-IP network path. This
is a shared transport condition, not an MCP tool or Node service failure.

## Chosen Architecture

### 1. Manual session ownership

The user continues to open `cf_mcp` manually. It starts the local MCP service if
needed and starts a dedicated production connector supervisor for that launch
session. Nothing is registered for Windows startup and no Windows service is
installed or started.

The supervisor has an explicit pid/state file in a protected local runtime
directory outside the repository. A stop command and the launcher cleanup path
can identify and stop only the processes created for this production session.
The test connector has separate configuration, port, hostname, and runtime state
and is never selected by production actions.

### 2. Connector health state

The supervisor treats the connector as healthy only when all of these hold:

1. the local MCP health endpoint returns `status: ok`;
2. cloudflared's local metrics endpoint reports at least one active HA
   connection; and
3. the public production health endpoint returns a valid MCP health response.

The supervisor checks at a bounded interval with a failure threshold to avoid
restarting for a single transient request failure. It records only timestamps,
component states, HTTP status classes, and restart counts. It never records
authorization headers, MCP tokens, cloudflared credentials, environment dumps,
or response bodies containing sensitive data.

### 3. Recovery behaviour

When connector health fails for the threshold, the supervisor first confirms the
local MCP is still healthy. It then terminates only the production cloudflared
process whose command line matches the protected production config and tunnel
identity, waits for it to exit, and starts one replacement process using the same
configuration.

The Node MCP process is never restarted as part of connector recovery. Restart
attempts use bounded exponential backoff and a circuit-breaker limit. Once the
limit is reached, the supervisor preserves the local service, writes a concise
actionable failure record, and stops attempting restarts until the user manually
launches a new session.

### 4. Network path

The installation guide will define narrowly scoped Mihomo rules for the
Cloudflare Tunnel transport hostnames. Those rules avoid fake-IP mapping for the
connector's long-lived outbound connections and route them according to the
user's selected stable egress policy. They do not change generic browsing,
other proxy rules, or the independent test connector.

The implementation validates the resulting resolution and connector readiness
before declaring the public channel usable. A failed network-rule validation
does not weaken MCP authentication, host validation, or directory permissions.

### 5. Component update

The repair upgrades cloudflared to the currently recommended release using the
existing Windows installation mechanism. It verifies the installed executable
version before starting the managed connector and retains no downloaded binary
inside the repository.

## Interfaces and Boundaries

| Component | Responsibility | Must not do |
| --- | --- | --- |
| `cf_mcp` launcher | Starts one manual production session and reports its state | Register automatic startup or operate test resources |
| Connector supervisor | Measures connector health and restarts only the matched production connector | Restart Node, read secrets, or execute arbitrary commands |
| Health probe | Makes bounded local/metrics/public checks | Log credentials or arbitrary response content |
| Mihomo guidance | Supplies narrowly scoped connector routing instructions | Replace the user's overall proxy configuration |
| Test launcher | Continues to own test port/hostname/credentials only | Share production runtime state |

## Lifecycle

```text
manual cf_mcp launch
  -> ensure local MCP on 3000
  -> start or adopt healthy production connector
  -> supervisor probes local + connector + public health
       -> healthy: wait for next interval
       -> repeated unhealthy: restart only production cloudflared
       -> recovery limit reached: report manual action required
manual stop
  -> stop only the production session supervisor and its connector
```

## Error Handling

- A missing or invalid production config stops the launch before any process is
  started.
- A process that merely exists but has zero HA connections is unhealthy and may
  be replaced after the failure threshold.
- If local MCP is unavailable, the supervisor reports it separately and does not
  incorrectly attribute the failure to Cloudflare.
- If public health fails while local and HA health pass, the report identifies
  it as public-edge/DNS reachability rather than restarting Node.
- The launcher rejects runtime files whose paths resolve outside its designated
  runtime directory.
- A pre-existing unrelated cloudflared process is never terminated.

## Verification

Unit and script tests cover process matching, state-file path validation,
health-state transitions, retry/backoff/circuit-breaker limits, safe log
redaction, and production/test isolation. Runtime verification confirms:

1. local production health is valid;
2. `cloudflared tunnel info` shows one or more active production connections;
3. public production health is valid and reports the expected tool inventory;
4. a simulated connector-only failure triggers a connector replacement without
   restarting Node; and
5. closing the manual session leaves no automatic-start registration behind.

## Explicit Non-goals

- No Windows service installation or modification.
- No boot/login auto-start.
- No changes to MCP tool authorization, host validation, or filesystem policy.
- No production/test configuration sharing.
- No automatic modification of unrelated Mihomo policy.
