# Restricted Node Development Tool Design

## Goal

Expose a structured MCP tool that lets an Aily agent run four approved PNPM
development actions in an authorized project directory without exposing an
arbitrary shell-command input.

## Context

The local MCP `tools/list` response includes the generic `execute_command`
tool, but Aily does not attach that tool to the agent. Aily does attach
structured development tools such as `windows_development`. The new tool must
therefore express an allowlisted Node workflow rather than accept command text.

## Public tool contract

Register one tool named `node_development` with this input:

```text
action: "pnpm_version" | "test_run" | "build" | "typecheck"
workdir: string (required)
timeout: positive integer in milliseconds (optional)
```

The action is required and no field accepts a command, argument list, package
script name, shell expression, executable path, or environment override.

| Action | Fixed executable | Fixed arguments |
| --- | --- | --- |
| `pnpm_version` | `pnpm` | `--version` |
| `test_run` | `pnpm` | `test:run` |
| `build` | `pnpm` | `build` |
| `typecheck` | `pnpm` | `typecheck` |

The tool returns the existing process result shape: success flag, action,
exit code, stdout, stderr, truncation status, and duration. It does not create
long-running development-task records.

## Security and execution model

1. Authenticate the caller with the existing regular tool authorization.
2. Resolve and authorize the required `workdir` through the existing directory
   guard. Reject missing, non-directory, protected approval-data, outside-root,
   or denied-directory paths before starting a process.
3. Request a normal single-use Aily approval for every action. The approval
   subject displays the fixed PNPM action and the resolved working directory.
   A client that cannot handle in-window elicitation is denied; no terminal or
   browser confirmation fallback is introduced.
4. On non-Windows hosts, execute `pnpm` with a fixed argv array through
   `runProcess`. On Windows, execute the `pnpm.cmd` shim through a fixed
   `cmd.exe /d /s /c` invocation because Node cannot directly spawn `.cmd`
   files with `shell: false`. The complete Windows command fragment is built
   only from the closed action map, never from a caller value. Preserve the
   existing command concurrency group, output byte cap, cancellation signal,
   default timeout, and maximum timeout.
5. Add the action and resolved directory to the audit/concurrency subject, but
   never accept caller-provided commands or arguments.

`pnpm_version` intentionally follows the same approval policy as the other
actions. This keeps the policy simple and accounts for a machine-local PNPM
executable or package-manager configuration being able to have side effects.

## Code boundaries

- `src/tools/nodeDevelopment.ts` owns the action enum, fixed action-to-argv
  table, validation, approval request, and direct PNPM process invocation.
- `src/index.ts` imports and registers the tool and lists it in the health/tool
  inventory, raising the total from 31 to 32.
- `src/security/consent.ts` is extended only if the path-consent registry needs
  an entry for `node_development.workdir`; the directory authorization helper
  remains the authoritative boundary check.
- `test/node-development-tool.test.mjs` verifies each action mapping, required
  working directory, directory denial, approval behavior, process failure, and
  the lack of a free-form command field.
- Tool inventory and integration tests are updated to expect 32 tools.

## Documentation and Aily guidance

Update the README, Aily integration guide, and personal onboarding skill to:

- list `node_development` as the supported route for Node/PNPM verification;
- instruct Aily to use this tool rather than `execute_command` for the four
  allowlisted actions;
- keep `execute_command` documented as a local MCP capability, while noting
  that an Aily agent may not receive generic shell execution;
- retain the personal registration guidance: Streamable HTTP, fixed
  `Authorization` header for Aily-side tool discovery, fixed `x-aily-user`,
  scope limited to the owner, and no secret values in descriptions or images.

## Acceptance criteria

- `tools/list` contains `node_development` and reports 32 tools.
- The tool schema has a four-value action enum and required `workdir`, with no
  field for arbitrary command text.
- Each action invokes only its documented PNPM arguments.
- Calls outside an allowed directory do not start PNPM.
- Approval, timeout, cancellation, output cap, and audit/concurrency behavior
  remain in force.
- The project builds and all affected tests pass.
- README, Aily guide, and onboarding skill describe the new supported workflow
  and the fixed-header registration requirement.
