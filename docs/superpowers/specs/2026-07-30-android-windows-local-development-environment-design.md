# Android and Windows Local Development Environment Design

**Date:** 2026-07-30

**Status:** Design approved; pending written-spec review

## Objective

Extend `feishu-mcp` from a local filesystem and development-command server into a stable, owner-controlled Android and Windows development environment. A Feishu agent must be able to inspect and provision trusted toolchains, create projects, build, test, package, sign, run, and diagnose applications through the existing authenticated ngrok endpoint.

The implementation keeps the current 21 tools unchanged and adds 9 structured tools, for a total of 30. It does not turn the MCP endpoint into unrestricted remote shell or desktop-control software.

## Confirmed Scope

### Included

- Android development with JDK, Android SDK, Gradle, ADB, emulators, APK/AAB builds, tests, deployment, diagnostics, file transfer, port forwarding, and signing.
- Windows `.NET` development with Visual Studio, MSBuild, .NET SDK, WPF, WinUI, MSIX, tests, publishing, signing, and process execution.
- Windows native development with MSVC, Windows SDK, CMake, Ninja, CTest, installation, and CPack.
- Electron development with Node.js, lockfile-based dependency installation, tests, packaging, signing, and process execution.
- Environment detection and approved installation, upgrade, or repair from fixed trusted sources.
- Project inspection and creation from controlled templates.
- Persistent background tasks with bounded concurrency, incremental logs, cancellation, artifacts, and restart recovery.
- A separately installed, least-privilege administrator broker for allowlisted privileged operations.

### Excluded from this phase

- Photoshop and Godot adapters.
- Mouse, keyboard, window, IDE, debugger, or general GUI automation.
- Arbitrary remote shell, arbitrary executable paths, arbitrary download URLs, and arbitrary administrator commands.
- Rooting Android devices, unlocking bootloaders, disabling platform security, or bypassing application and device isolation.
- Automatic retry of installations, signing, device writes, or interrupted builds.
- Remote desktop, screen streaming, and unrestricted process termination.

## Design Decision

Use a shared orchestration core with thin Android and Windows adapters and a separate administrator broker.

Expanding `execute_command` would be quick but would preserve fragile shell-string construction and provide weak operation-level audit boundaries. Building two independent adapters would duplicate task, log, cancellation, concurrency, installation, and approval logic. The shared-core design gives both platforms the same stable lifecycle while keeping application-specific validation isolated.

```text
Feishu agent
  -> existing transport authentication and owner identity
  -> directory and operation approval
  -> structured Android/Windows/environment tool
  -> trusted executable resolver and argument validator
  -> persistent task coordinator
       |-> ordinary-user worker: build, test, package, ADB, run
       `-> local administrator broker: allowlisted system changes
  -> incremental logs, status, artifacts, and cancellation
```

## Security Model

### Owner-only control

All 9 new development-environment tools are owner-only in the first release. Passing transport authentication or PIN authentication as another user does not grant application, device, package-manager, or administrator access. The broker is also bound to the configured owner and the corresponding Windows user SID.

Existing filesystem tools retain their current multi-user and directory-authorization behavior.

### Project and toolchain paths

- Project source, templates written to disk, signing inputs, and build outputs remain subject to the existing directory-authorization model.
- Trusted toolchain directories outside the owner's ordinary project roots may be inspected, read, and executed only through the new adapters.
- Trusted toolchain status does not add those directories to `list_allowed_directories` and does not grant any new permission to general filesystem or command tools. Generic tools remain subject to their existing, independent policies.
- Writes outside an authorized project root are limited to known tool-owned caches, SDK locations, emulator storage, or broker allowlisted system targets.
- The task data directory and broker security data are treated like the existing approval data directory and are inaccessible through MCP file, search, diff, patch, Git, and command tools.

### Trusted executable resolution

Adapters do not accept executable paths from callers. Executables are discovered through fixed mechanisms such as registry data, `vswhere`, official installation metadata, configured SDK roots, and verified package-manager records.

Before use, the resolver records the canonical path, file identity, version, publisher or checksum when available, and discovery source. Symlinks, junctions, path changes, publisher changes, or incompatible versions invalidate the cached resolution.

### Approval classification

Read-only environment inspection, task status, and owner-scoped task-log reads do not require operation approval after authentication.

The following always require an exact operation approval before the task is queued:

- installing, updating, repairing, or uninstalling toolchains;
- creating a project or changing a project through dependency installation;
- executing project-owned scripts or newly changed Gradle/package-manager logic;
- building code whose executable script digest has not already been approved;
- signing, installing, uninstalling, starting, stopping, or clearing an application;
- emulator creation or system-image changes;
- device writes, file transfer to a device, port forwarding, or ADB shell;
- running a newly built Windows executable.

Safe repeated builds and tests may use the existing once, session, or exact permanent approval choices. The approval subject binds the user, tool, action, canonical project root, toolchain identity, relevant manifest or script digest, target, and arguments. A project script or manifest change invalidates the approval.

Privileged plans, signing, uninstall, application-data clearing, and ADB shell are single-use decisions. A previous permanent approval cannot authorize a different plan or changed destructive operation.

## MCP Tool Inventory

The 21 existing tools keep their names, schemas, and behavior. The following 9 tools are added.

### 1. `inspect_development_environment`

Detects requested Android, `.NET`, native Windows, and Electron capabilities. It returns structured component status, compatible versions, missing workloads, trust status, and remediation summaries. Raw credentials and sensitive environment variables are never returned.

### 2. `plan_environment_changes`

Produces an immutable installation, upgrade, or repair plan without changing the machine. A plan contains exact component IDs, versions, sources, estimated download and disk sizes, privilege requirements, possible reboot impact, environment snapshot digest, expiry, and a random plan ID.

### 3. `apply_environment_plan`

Accepts only a valid plan ID. It cannot append packages, commands, URLs, switches, or executable paths. The environment snapshot, catalog, expiry, owner, and broker version must still match. Applying a plan always requires approval.

### 4. `manage_development_project`

Supports `inspect` and `create` actions for Android, `.NET`, native CMake, and Electron projects. Creation accepts structured fields such as destination, name, application/package ID, target SDK, framework, architecture, and template ID.

Android has no stable official headless equivalent of the Android Studio new-project wizard. Android creation therefore uses repository-maintained, versioned, reviewable templates pinned to official Android Gradle Plugin, Gradle, Kotlin, and Android repositories. The tool does not claim to invoke a nonexistent official CLI project generator.

### 5. `get_development_task`

Returns owner-scoped task state, stage, timestamps, progress where determinable, exit classification, non-secret summary, and artifact metadata.

### 6. `read_development_task_logs`

Reads redacted task logs using a cursor, byte/line limit, and stdout/stderr selection. It returns the next cursor and truncation state so the model does not repeatedly consume the full log.

### 7. `cancel_development_task`

Requests cancellation of queued or running work. It only controls tasks created by this service for the owner and cannot terminate unrelated local processes.

### 8. `android_development`

Uses an action enum and action-specific fields. Supported action groups are:

- SDK, device, and AVD inspection;
- AVD creation, start, stop, and readiness checks;
- Gradle clean, build, APK/AAB production, unit tests, and device tests;
- application install, uninstall, start, stop, and data clearing;
- Logcat capture, screenshots, bounded file push/pull, and forward/reverse port mapping;
- restricted ADB shell diagnostics;
- APK/AAB signing and signature verification.

Every device-affecting call requires an explicit device serial. If more than one device exists, the adapter never guesses a default.

Restricted ADB shell accepts a structured diagnostic operation or a strict allowlisted token sequence. It rejects shell operators, redirection, substitution, nested shells, package installation outside the dedicated action, privilege escalation, security-setting changes, bootloader operations, and arbitrary host execution.

### 9. `windows_development`

Uses a structured ecosystem and action enum:

- `.NET`: restore, build, test, publish, pack, sign, run, and stop;
- Visual Studio/MSBuild: solution/project build and test with a selected verified instance;
- native: CMake configure, build, test, install-to-authorized-destination, and CPack;
- Electron: frozen dependency installation, test, build, package, sign, run, and stop.

Electron may run only a script name present in the authorized project's current `package.json`. The adapter displays and digests the resolved script before approval and never accepts command suffixes. A changed script requires a new approval.

## Environment Provisioning

### Trusted sources

- `winget` with exact package IDs and approved official sources.
- Microsoft-signed Visual Studio Installer with exact workload/component IDs.
- Microsoft official .NET and Windows SDK distribution mechanisms.
- Google Android repository metadata and SDK Manager package IDs.
- Fixed trusted JDK, CMake, Ninja, Node.js, and related package publishers.

The service rejects caller-provided URLs, web-returned scripts, certificate-validation bypasses, and package-source substitutions. Downloads are checked against catalog hashes or Windows signatures where the source provides them.

Visual Studio and Android plans install only the workloads and SDK versions requested by the selected project profiles. "Complete" means all supported workflows can be provisioned; it does not mean installing every historical SDK and workload by default.

### Dependency behavior

- Android uses the project's Gradle Wrapper. Remote distributions require `distributionSha256Sum` or a matching trusted catalog entry.
- .NET honors locked dependencies when present and only uses configured NuGet sources.
- Electron uses a recognized lockfile and frozen/clean installation mode by default.
- Creating or changing a dependency lock requires a separate approved action.
- Project scripts are treated as executable project code, not trusted merely because they are in a manifest.

## Administrator Broker

The broker is a separate Windows service distributed as a versioned, self-contained release artifact with source in the repository. Installation is a one-time local action that requires UAC. The MCP Node process continues to run as an ordinary user.

The broker:

- listens only on a local Windows named pipe, never TCP;
- applies a pipe ACL restricted to the configured Windows user SID and service identity;
- authenticates timestamped, nonce-bearing requests and rejects replay;
- accepts only built-in operation IDs and typed component fields;
- reconstructs and validates the operation independently instead of executing caller-supplied paths or arguments;
- checks owner SID, plan signature, environment digest, plan expiry, catalog version, and MCP/broker protocol version;
- serializes privileged operations and emits redacted structured progress;
- has no generic shell, file-delete, URL-download, or process-launch operation;
- cannot modify its own allowlist from an MCP request.

Broker installation material contains no repository or transport credentials. Per-machine authentication and SID data are created during installation, protected locally, and ignored by Git.

## Credentials and Signing

Tool schemas never accept passwords, private keys, bearer tokens, certificate export data, or keystore passwords. They accept a local credential reference ID.

Secrets are stored through Windows Credential Manager or DPAPI-protected local storage and are supplied to child processes through the narrowest supported mechanism. They are not placed on command lines when the underlying tool supports safer input. Returned certificate and keystore information is limited to aliases, public fingerprints, issuer, purpose, and validity dates.

README instructions must explicitly warn users not to paste signing secrets into Feishu chat or commit them to `.env`.

## Persistent Task Engine

### Lifecycle

```text
queued -> running -> succeeded
                  -> failed
                  -> cancel_requested -> cancelled
                  -> interrupted
```

Approval completes before a task enters the queue. Each long operation runs in an independent worker with an opaque task ID, start identity, heartbeat, current stage, redacted append-only logs, and atomic metadata.

The task store uses per-task JSON metadata written by temp-file, flush, and atomic replace, plus append-only log files. This avoids adding a native database dependency to the Windows Node deployment.

### Disconnect and restart behavior

- A Feishu or ngrok disconnect does not cancel a worker.
- On MCP restart, a live worker with a valid identity and heartbeat is reattached for status, logs, and cancellation.
- A missing or unverifiable worker is marked `interrupted`.
- Interrupted work is never automatically restarted.
- Installations, signing, and device writes are never automatically retried.
- Completed task metadata and artifacts remain queryable during the retention window.

### Cancellation

Cancellation first requests graceful termination through the task-control channel. After a configured grace period, the coordinator may terminate the verified task process tree. It verifies the worker identity, creation time, nonce, and ownership before any forced termination so PID reuse cannot target an unrelated process.

### Storage and retention

Task data defaults to `%LOCALAPPDATA%\feishu-mcp\tasks` and is excluded from Git. Logs are cursor-readable, size-bounded, and redacted before persistence. The default retention is 14 days with a configurable total-size limit. Automatic cleanup affects only terminal-state tasks and never deletes project artifacts.

The `/health` endpoint exposes counts and saturation only. It does not expose task IDs, project paths, device serials, user IDs, broker secrets, or toolchain paths.

## Concurrency and Resource Locks

Stable defaults are:

- 4 total background tasks;
- 2 simultaneous builds;
- 1 privileged installation or system-change task;
- 1 state-changing task per canonical project root;
- 1 state-changing task per Android device serial;
- independent projects and devices may run concurrently within global limits.

Limits are configurable downward or upward. Invalid, zero, or unreasonably high values fail closed or are capped. Queued work has a bounded queue and queue-wait timeout. Resource locks are acquired in a fixed order to prevent deadlocks and are always released after failure or cancellation.

## Error Model

All tools return structured, non-secret error codes with a concise remediation message. Core codes include:

- `ENVIRONMENT_MISSING`
- `ENVIRONMENT_PLAN_STALE`
- `TOOLCHAIN_UNTRUSTED`
- `BROKER_UNAVAILABLE`
- `BROKER_VERSION_MISMATCH`
- `DEVICE_NOT_FOUND`
- `DEVICE_AMBIGUOUS`
- `PROJECT_BUSY`
- `TASK_QUEUE_FULL`
- `TASK_INTERRUPTED`
- `TASK_CANCELLED`
- `BUILD_FAILED`
- `TEST_FAILED`
- `PACKAGE_FAILED`
- `SIGNING_CREDENTIAL_NOT_FOUND`

Raw child-process exceptions are logged only after redaction. Tool responses include bounded diagnostic excerpts and a task-log cursor rather than dumping unbounded output.

## Validation Strategy

### Automated tests

- Schema and action-specific validation for all 9 new tools.
- Executable discovery, canonicalization, signature metadata, cache invalidation, junction, and spoofing tests.
- Environment-plan expiry, snapshot mismatch, component substitution, arbitrary URL, and argument-injection tests.
- Task state transitions, atomic persistence, restart reattachment, stale heartbeat, cancellation, PID-reuse protection, retention, and concurrency-lock tests.
- Log redaction tests covering credentials, tokens, authorization headers, keystore arguments, certificate material, and sensitive environment variables.
- Android adapter tests using disposable fake Gradle, SDK Manager, emulator, and ADB executables.
- Windows adapter tests using disposable fake `dotnet`, MSBuild, CMake, Ninja, Node, and packager executables.
- Broker protocol tests for ACL expectations, owner mismatch, replay, stale requests, plan tampering, version mismatch, and unsupported operation IDs.
- HTTP MCP end-to-end tests for the exact 30-tool inventory, approval retry, background tasks, incremental logs, cancellation, artifacts, owner isolation, and protected internal data.
- Existing Node, Python, audit, type-check, and secret-history checks remain required.

Automated tests must not install workloads, modify real SDKs, change real devices, or write into user projects. They use temporary roots and fake toolchains.

### Real Windows acceptance

Android acceptance:

1. Inspect and, when missing, plan and approve JDK and Android SDK components.
2. Create a controlled Kotlin Android project in an authorized temporary root.
3. run unit tests and produce debug APK, release APK, and AAB artifacts;
4. create and boot an emulator, wait for device readiness, and require an explicit serial;
5. install and start the app, read Logcat, capture a screenshot, transfer a test file, and test port forwarding;
6. stop, clear, and uninstall the app with exact approvals;
7. reference a local test keystore, sign an artifact, and verify its signature without exposing secrets.

Windows acceptance:

1. Create, restore, build, test, publish, run, and stop a `.NET` example; inspect WPF, WinUI, and MSIX requirements.
2. Create a native CMake example, build it with verified MSVC/Ninja, and pass CTest.
3. Create an Electron example with a lockfile, install dependencies in frozen mode, test, package, run, and stop it.
4. Detect Visual Studio instances and workloads and build a solution using the selected verified instance.
5. Sign a disposable artifact with a referenced test certificate; verify that a missing credential produces `SIGNING_CREDENTIAL_NOT_FOUND`.
6. Verify administrator-plan success and rejection of expired, replayed, modified, arbitrary-path, arbitrary-URL, and incompatible-version requests.

The final real-path check runs through the authenticated `/mcp` endpoint and the existing fixed ngrok launcher. It must not change the configured ngrok domain or print transport, PIN, approval, broker, or signing secrets.

## Documentation

`README.md` will retain the quick start and add:

- the exact 30-tool inventory;
- administrator-broker installation and removal;
- environment inspection, plan generation, approval, and apply examples;
- project creation and inspection examples;
- Android build, emulator, device, logging, file-transfer, and signing examples;
- `.NET`, native, and Electron build/test/package/run examples;
- task status, incremental logs, cancellation, and artifacts;
- concurrency, retention, trusted-toolchain, and owner-only rules;
- operations that always require Feishu confirmation;
- local files and secrets that must never be committed.

Detailed operational documentation will live in `docs/local-development-environment.md`. Examples will use natural-language Feishu requests first, with MCP parameter examples only where needed for integration debugging.

## Public Repository Requirements

- Task data, logs, worker PID/nonce data, broker registration data, per-machine catalogs, credential references, certificates, keystores, and environment-local configuration are ignored by Git.
- Repository and Git-history scans must find no live Bearer token, PIN, approval key, broker secret, signing password, private key, or stored grant.
- The fixed ngrok domain may appear as deployment documentation only if it is intentionally public; no ngrok credential or auth token may be stored.
- The public repository contains broker source, schemas, tests, templates, and installation documentation, not machine authority.

## Completion Criteria

The feature is complete only when:

- all 21 existing tools remain backward compatible;
- `tools/list` returns exactly 30 tools;
- all new tools are owner-only and preserve current directory boundaries;
- trusted-toolchain classification creates no directory grant or reusable approval for generic file or command tools;
- the administrator broker cannot execute arbitrary commands, paths, URLs, or caller-defined arguments;
- task recovery, logging, cancellation, retention, concurrency, and resource locks pass automated and real Windows checks;
- the Android and Windows acceptance paths above pass on the target machine;
- the fixed ngrok endpoint passes authenticated real-client verification;
- README and detailed usage documentation match implemented behavior;
- production dependency audit reports no known vulnerabilities;
- tracked files and Git history contain no local authority or secret material.
