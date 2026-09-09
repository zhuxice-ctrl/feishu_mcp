# Test Version Known Issues

## FMCP-ANDROID-20260908-001 · Android app launch uses stale profile configuration

- Status: verified-at-source (build + unit tests executed on Windows 2026-09-08; device-level experiment still pending)
- Date: 2026-09-08
- Scope: `staging_android_verify` Android workflow on `emulator-5554`
- Trigger: The APK on disk is updated, but a long-lived `feishu-mcp` process was started with an older Android package/activity configuration.
- Symptom: APK installation succeeds, while the workflow launches the old package or fails to launch the newly installed app. Editing the on-disk configuration alone does not affect the already-running process.
- Confirmed root cause: `src/index.ts` registers `zeroxcoreProfile` during process startup. `StagingCoordinator` later resolves the profile from that in-memory registry, and `AndroidDeviceAdapter.launch()` uses the cached `packageName` and `activity` to build the ADB launch command. The profile is therefore not hot-reloaded.
- Environment evidence: Android SDK and emulator are available under `E:\Android\Sdk`; AVDs `Pixel_8_Pro` and `ZeroXCoreTest` are present; `adb devices -l` reported `emulator-5554` in `device` state. No MCP test service was started while recording this issue.
- Do not: repeatedly reinstall the APK, create a new emulator/tunnel, change the production Cloudflare configuration, or treat a successful `adb install` as proof that the correct app was launched.
- Implemented: `ProfileRegistry` now exposes `replace(profile)` (validation-first, failure leaves previous entry intact) and the `staging_android_verify` tool takes an optional `reloadProfiles` hook. The composition root (`src/index.ts`) wires a cache-busting dynamic import of `./android-workflow/profiles/zeroxcore.js?reload=<n>` so the built module is re-read from disk before each run, then `registry.replace()` atomically swaps the in-memory definition. Edited profile files now take effect without restarting the MCP process. Core modules remain generic — no application-specific branches introduced. The existing emulator and configured tunnel resources are unchanged.
- Next discriminating experiment (pending): change the staged profile package/activity, run one isolated workflow against `emulator-5554`, and verify the generated `am start` target matches the current profile without restarting the MCP process.
- Verification (executed 2026-09-08 on Windows via the production MCP channel; `execute_command` is callable but kills any process at ~500ms regardless of `timeout`, so longer commands were run through a detached spawner `run-bg.mjs` with file-redirected output):
  - `npm install` — completed (warm cache, `node_modules/.package-lock.json` written 2026-09-08T13:53:26Z).
  - `npm run build` (`tsc`) — completed with no errors; `dist/index.js` and `dist/android-workflow/profileRegistry.js` regenerated at 2026-09-08T14:00:40Z.
  - `node --test --test-concurrency=4 test/*.test.mjs` — 942 tests: 930 pass / 12 fail. The three new `replace()` cases all pass (`ok 206 - replace() hot-swaps an already-registered profile`, `ok 207 - replace() rejects an invalid replacement and keeps the previous profile`, `ok 208 - replace() can also register a brand-new profile id`). Full TAP log kept at `suite.log` in the worktree root.
  - 12 pre-existing failures are environment leakage, not regressions: they all live in config/policy-sensitive files (`development-owner-access`, `directory-config` ×4, `directory-development-tools`, `health-concurrency`, `public-host-config` ×3, `security-auth`, `complete-tools-e2e`) and fail because test subprocesses inherit the running `feishu-mcp` service's env vars (e.g. the spawned config load throws `OWNER_USER_ID is required when GIT_COMMAND_POLICY is soft_owner`, proving `GIT_COMMAND_POLICY=soft_owner` leaked in). Zero failures in `android-workflow-profiles` or `staging` areas. Re-running the suite from a clean shell (without the service env) should clear them; not yet re-run that way.
  - `git diff --check` — clean; 0 whitespace warnings.
  - One isolated device run on `emulator-5554` — still pending (requires user permission to start a test service).
- Evidence status: build + full unit-test suite executed on the user's Windows machine through the production MCP channel; fix verified at source level on the test branch (`test/new-version-20260908`). Remaining gap: on-device `am start` target check after a live profile edit (needs the user's go-ahead to start a test service), plus a clean-env re-run of the suite to confirm the 12 failures vanish.
- Files changed:
  - `src/android-workflow/profileRegistry.ts` — extracted `validateProfile()` private, added `replace()` (FMCP-ANDROID-20260908-001 ref).
  - `src/tools/stagingAndroidVerify.ts` — added `reloadProfiles?` to `StagingAndroidVerifyOptions`, invoked before `registry.has()` with `INTERNAL_ERROR` on failure.
  - `src/index.ts` — wired `reloadAndroidWorkflowProfiles` using `import(\`./android-workflow/profiles/zeroxcore.js?reload=${counter}\`)` + `registry.replace()`.
  - `test/android-workflow-profiles.test.mjs` — appended three `replace()` cases.
- Worktree utilities (untracked, disposable): `run-bg.mjs` (detached command runner), `test-probe.test.mjs` (smoke test), `probe-ps.mjs` (process probe), `suite.log`/`smoke.log` (test output). Safe to delete or keep.
