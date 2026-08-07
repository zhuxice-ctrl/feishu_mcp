# ngrok Fake-IP Launcher Compatibility Design

## Problem

The launcher verifies a locally running MCP server, waits until ngrok reports
the configured fixed HTTPS tunnel, then makes a public `/health` request back
through the configured ngrok domain. On this workstation, Clash Fake-IP
resolves that domain to `198.18.0.146`, so the loopback public-health request
times out even after ngrok has established the tunnel. The launcher treats
that local-network limitation as a tunnel failure and terminates both healthy
processes.

## Decision

Keep local MCP health and ngrok tunnel registration as mandatory startup
checks. Change the public HTTPS health request into a best-effort diagnostic:
when it succeeds, validate the expected version and 31-tool inventory; when
it times out or fails, emit a warning that identifies local proxy/Fake-IP
interference and continue running the established MCP server and ngrok
tunnel.

## Boundaries

- Do not accept a missing or mismatched fixed ngrok endpoint.
- Do not relax local `/health` validation, token configuration, or startup
  configuration validation.
- Do not log credentials, headers, or response bodies.
- Keep the public health check to detect successful reverse-path access where
  the local network permits it.

## Verification

Add launcher tests that retain assertions for the fixed HTTPS endpoint,
ngrok warning-bypass header, and 31-tool health contract. Add a static
regression assertion that public-health failure is handled as a warning rather
than entering the launcher's terminating error path. Run launcher tests and
the TypeScript build.
