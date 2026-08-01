# Git Soft Approval Compatibility Design

## Goal

Allow the configured owner to use Git through `execute_command` from an Aily
client that cannot complete MCP `inputRequired` elicitation. Ordinary Git
operations execute directly. High-impact Git operations remain available, but
require an explicit conversational confirmation before an exact retry.

This design does not relax approval for non-Git commands and does not globally
auto-approve `execute_command`.

## Scope and policy

The feature is enabled by an explicit deployment setting. Its safe default is
the existing approval behavior. Soft Git authorization applies only when all of
the following are true:

- the configured policy is `soft_owner`;
- the request identity matches the configured owner;
- the working directory has passed the existing directory authorization and
  physical-path checks;
- the command is a single, directly invoked `git` or `git.exe` command;
- the command contains no shell operators, redirection, substitution, newline,
  or wrapper interpreter.

Requests that do not satisfy those conditions use the existing command
approval behavior. No non-Git command inherits Git authorization.

Within the Git policy there are two outcomes:

1. `authorized`: ordinary Git reads and writes execute immediately.
2. `confirmation_required`: high-impact, boundary-changing, ambiguous, or
   unknown Git forms return a soft confirmation challenge. They are not
   permanently forbidden.

## Classification

Classification uses tokenized Git arguments rather than substring matching.
The direct-execution allowlist includes ordinary repository work such as:

- inspection commands (`status`, `log`, `show`, and ordinary `diff`);
- staging and commits (`add` and non-amending `commit`);
- ordinary branch creation/switching;
- merge, cherry-pick, and revert;
- fetch, pull, and non-force/non-deleting push.

The confirmation category includes at least:

- `reset`, `clean`, path-overwriting checkout/restore, and stash deletion;
- `commit --amend`, rebase, reference deletion, and reflog expiration;
- force, mirror, pruning, or deleting pushes;
- remote, config, hooks, aliases, helpers, filters, credentials, submodules,
  worktrees, custom transports, external diff tools, and executable overrides;
- global path overrides such as `-C`, `--git-dir`, and `--work-tree`;
- unknown subcommands or option shapes.

The classifier is intentionally fail-soft: an unrecognized Git form requires
confirmation instead of being rejected or automatically executed.

## Conversational confirmation flow

`execute_command` accepts an optional opaque `confirmationToken`.

For a high-impact Git command without a valid token:

1. The server does not start a process.
2. It returns a structured `GIT_CONFIRMATION_REQUIRED` result containing a
   human-readable exact-command summary and a signed, short-lived, one-time
   token.
3. Aily must display the summary and wait for an explicit user confirmation.
4. After confirmation, Aily retries `execute_command` with the same command,
   working directory, timeout, and returned token.
5. The server verifies and consumes the token, then executes the command.

The token is authenticated with the existing approval signing secret and binds
the owner identity, normalized command, resolved working directory, relevant
argument digest, issue/expiry times, and a nonce. A changed command, changed
directory, changed identity, expired token, or replay is denied. Tokens and
command text are not written to health output or ordinary logs.

This flow is a compatibility path for clients without MCP elicitation. Modern
clients continue to use the existing native approval flow unless the explicit
owner soft policy is enabled for Git.

## Configuration and observability

Add `GIT_COMMAND_POLICY` with two accepted values:

- `approval` (default): current behavior;
- `soft_owner`: ordinary owner Git commands execute directly and high-impact
  owner Git commands use conversational confirmation.

The current local deployment will explicitly set `soft_owner` after tests pass.
The health response exposes only the effective policy name and never exposes a
token, identity, command, repository path, or signing material.

Audit logs record the policy outcome (`authorized`, `confirmation_requested`,
`confirmation_accepted`, or `confirmation_rejected`) and a non-reversible
command subject digest. They do not record raw command arguments.

## Error handling

- Invalid configuration fails startup with a clear non-secret error.
- Missing or non-owner identity falls back to the existing approval path.
- Invalid, expired, mismatched, or replayed confirmation tokens return a
  structured denial and never execute a process.
- Commands that are not safely tokenizable use the existing approval path.
- Process timeout, cancellation, output limits, and process-tree cleanup remain
  unchanged.

## Tests

Unit tests cover Git tokenization and both categories, including ordinary
commits and pushes, destructive operations, global overrides, helpers, unknown
subcommands, shell metacharacters, and wrapper interpreters.

Tool tests verify:

- ordinary owner Git writes execute without `inputRequired` under
  `soft_owner`;
- high-impact commands do not execute on the first call;
- an exact confirmed retry executes once;
- altered command, workdir, timeout, identity, expired token, and token replay
  are denied;
- non-owner and non-Git requests keep the existing behavior;
- default configuration remains `approval`;
- health and logs do not leak commands, paths, identities, tokens, or secrets.

The full Node, Broker, Python, audit, secret-scan, and launcher regression gates
run before activating the policy in the current local service.

## Deployment and rollback

After all tests pass, activate `GIT_COMMAND_POLICY=soft_owner` only for the
current owner deployment, restart the MCP service, and verify the health policy
plus one harmless Git read and one disposable confirmation challenge. Do not
perform a destructive Git operation merely to test the feature.

Rollback consists of setting the policy back to `approval` and restarting the
service. No stored grants or repository state need migration.
