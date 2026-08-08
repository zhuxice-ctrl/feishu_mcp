# Personal Developer README Refresh Design

## Goal

Make `README.md` the clear first-stop guide for an individual Windows developer
who wants to run this MCP on their own computer and connect it to their own
Aily workbench.

## Audience and scope

The primary reader has a Windows computer and may have a Node, Android, or
Windows-native project. They need a safe self-hosted setup, not a team service
or shared gateway. The README remains Chinese-first and retains deep technical
reference material, but its opening must support a successful first connection
without requiring the reader to understand the complete tool inventory.

## Information architecture

Use this order:

1. Project summary and an explicit statement that each computer owns its own
   `.env`, token, allowed directories, ngrok endpoint and Aily connection.
2. A short security warning: never share or commit secrets, and restrict the
   allowed directories to project roots.
3. A personal quick start: clone, install, copy `.env.example`, start the
   service, configure a personal ngrok tunnel, configure Aily headers, and
   verify the connection.
4. A local development environment section that points to
   `skills/personal-mcp-onboarding/SKILL.md` for detection-first manual setup
   of Node, Android and Windows-native prerequisites.
5. An updated tool inventory: 31 tools, grouped by capability, including
   `execute_command` and `manage_binary_artifact`.
6. A precise owner-command policy section: `approval` is the default;
   `direct` is an explicit owner-only configuration and still retains directory,
   protected-path, timeout, output and audit boundaries.
7. Existing detailed configuration, security, ngrok, Aily, examples and
   technical reference sections, corrected where their tool count, policy or
   launcher statements are stale.

## Content rules

- Do not put a real token, endpoint, ngrok authtoken, PIN, user identity or
  local personal path in examples.
- Show `Authorization: Bearer <the user's own MCP_AUTH_TOKEN>` only as a
  placeholder, and state that it belongs in the request-header value rather
  than a display-name or description field.
- Refer users to manual ngrok account creation and local configuration. Do not
  imply the project can create an account or tunnel without the user's action.
- Do not claim a fixed free ngrok domain exists. Explain that the Aily endpoint
  must reflect the user's active personal tunnel or configured reserved domain.
- Do not add a second shell endpoint. Describe the existing `execute_command`
  policy accurately.

## Corrections to existing README statements

- Replace the old 30-tool total and 21-plus-9 split with the current 31-tool
  inventory and its correct grouping.
- Replace the old `tools/list` always returns 30 claim with 31.
- Update the launcher text: local health and tunnel registration are required;
  the public health probe can warn under Clash Fake-IP and must not stop a
  healthy local service.
- Add `OWNER_COMMAND_POLICY=approval|direct` and its required owner identity to
  configuration guidance, but keep `approval` as the recommended default.

## Validation

Review all tool-count statements using the registered tool list in
`src/tools/registry.ts` and ensure all mentioned configuration keys occur in
`src/config.ts`. Run `npm run build` after the documentation edit and scan the
README for real-secret patterns or obsolete 30-tool claims.
