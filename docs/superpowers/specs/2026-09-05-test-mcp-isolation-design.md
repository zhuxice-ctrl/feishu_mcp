# Test MCP Isolation Design

## Purpose

Provide a repeatable test MCP environment for validating development-server
changes without modifying, restarting, sharing state with, or publishing over
the production MCP deployment.

## Boundary

Production remains the only consumer of `.env`, port `3000`,
`mcp.zxc66.asia`, its Cloudflare tunnel credentials, and its approval/task/log
directories. Test startup scripts must reject those values before starting a
process.

The test environment uses `.env.test`, loopback port `3001`, and the reserved
test hostname `mcp-test.zxc66.asia`. It requires separately supplied test
credentials and a separate Cloudflare configuration; no script derives a test
credential from a production file or process environment.

## Components and Data Flow

`scripts/start-test-mcp.ps1` loads only an explicit `.env.test` path. It
requires `PORT=3001`, `HOST=127.0.0.1`, `PUBLIC_HOST=mcp-test.zxc66.asia`, and
test-only directories below a dedicated test data root. It builds the existing
application and starts it with those process-only values. Its health check
must report the expected tool inventory, then it owns and stops only the Node
process it created.

`scripts/start-test-cloudflared.ps1` loads a separately named test tunnel
configuration. It rejects the production hostname, production tunnel ID or
credential filename, and any config that points to port 3000. It starts only
the test cloudflared process and does not control the production service.

`.env.test.example` documents placeholders for the test bearer token, data
root, workspace catalog, logs, and test hostname. It contains no secret or
production path. `.env.example` continues to describe production defaults and
notes that test values belong in the separate file.

## Safety Rules

- Test launchers bind only to `127.0.0.1:3001`; they never listen on production
  port 3000.
- Test state lives under an operator-selected `TEST_DATA_ROOT`, distinct from
  `APPROVAL_DATA_DIR` used by production.
- Test launcher validation rejects any production host, port, tunnel reference,
  or data directory.
- Neither launcher reads, changes, stops, or restarts the production MCP,
  Cloudflare service, or `.env`.
- The test tunnel is optional for local tests. A tunnel is started only with
  explicit test credentials and configuration.

## Verification

Automated tests run the launchers in check-only mode against generated test
configuration. They verify acceptance of only 3001/test host/test roots and
rejection of each production identifier. A separate local smoke check confirms
the production health endpoint remains reachable before and after test setup.
