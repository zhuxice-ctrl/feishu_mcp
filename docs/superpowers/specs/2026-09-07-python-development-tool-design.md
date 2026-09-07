# Python Development Tool Design

## Goal

Add a reusable MCP tool for running Python validation and scripts from an authorized project directory, including virtual-environment interpreters, without exposing a generic shell channel.

## Scope

The new `python_development` tool supports three closed actions:

- `python_version`: report the selected interpreter version.
- `script_run`: run one `.py` file or Python module from the authorized work directory.
- `pytest_run`: run pytest with controlled test targets and optional ignore targets.

The tool accepts an optional interpreter path. Relative interpreter paths are resolved under `workdir`; absolute paths must be inside an authorized directory. If omitted, the resolver checks `.venv/Scripts/python.exe`, `.venv/bin/python`, then the platform `py` launcher. The executable is invoked directly with an argument vector; no shell command string is constructed.

## Contract

Input fields:

- `action`: one of the three actions above.
- `workdir`: required authorized project directory.
- `python`: optional interpreter path or `py` launcher name.
- `script`: required for `script_run`, a `.py` file under `workdir`.
- `module`: optional module name for `script_run`; mutually exclusive with `script`.
- `pytestArgs`: optional structured values: `targets` (relative files/directories), `ignore` (relative files/directories), and `quiet` (boolean). Raw pytest flags are rejected.
- `timeout`: optional bounded timeout.

The tool remains owner-only and uses the existing directory proof, approval, concurrency, cancellation, output-limit, and redaction mechanisms. It rejects path traversal, internal approval directories, shell metacharacters in executable or module values, and script/pytest targets outside `workdir`.

## Architecture

Implement a focused `src/tools/pythonDevelopment.ts` module following the existing `nodeDevelopment.ts` pattern. Keep interpreter resolution, argument construction, and validation as pure functions so they can be tested without Python or pytest installed. Register the tool from `src/index.ts`, append it to `TOOL_NAMES`, and update the tool inventory, integration guide, and README.

## Testing

Add unit tests for interpreter discovery, Windows virtual-environment resolution, safe argument vectors, script/module exclusivity, pytest target and ignore validation, traversal rejection, timeout propagation, and owner authorization. Add inventory assertions and a fake-runner test that proves no shell is used. Real pytest execution remains opt-in and is not part of the default test suite.

## Non-goals

This change does not restore `execute_command`, accept arbitrary command strings, install Python packages, modify project files, or run real Android/desktop end-to-end tests.

