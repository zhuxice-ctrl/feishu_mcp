Exit code: 0
Wall time: 0.5 seconds
Output:
Exit code: 0
Wall time: 0.4 seconds
Output:
# Binary Artifact Pipeline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add one owner-only MCP tool that can safely receive verified binary artifacts and atomically place them in an approved project without text-file writes, shell commands, or binary Git commits.

**Architecture:** `manage_binary_artifact` dispatches a strict action schema to an isolated artifact subsystem. The subsystem streams URL downloads or ordered decoded chunks to private staging, verifies size/digest/type, promotes bytes to a content-addressed store, and materializes verified copies through existing directory authorization. Exact single-use approvals use MCP elicitation when available and a signed owner-only conversational challenge through `auth.binaryArtifactApproval` when Aily cannot render elicitation.

**Tech Stack:** Node.js 22, TypeScript ESM, Zod, `@modelcontextprotocol/server`, Node fs/crypto/http/https, Express, Node test runner, existing request-state codec and directory authorization.

---

## File structure

- Modify: `.gitignore`, `scripts/start-feishu-mcp.ps1`, `test/launcher.test.mjs` -keep the optional ngrok runtime project-local and ignored.
- Modify: `src/config.ts`, `src/tools/concurrency.ts`, `src/security/networkGuard.ts`, `src/tools/command.ts` - bounded artifact settings, owner build-verification policy, artifact lane, and a policy-selectable network guard.
- Create: `src/artifacts/types.ts`, `digest.ts`, `signatures.ts`, `store.ts`, `uploads.ts`, `urlImport.ts`, `materialize.ts`, `manifest.ts` -binary-only domain implementation.
- Create: `src/security/binaryArtifactApproval.ts`; modify `src/security/approvalState.ts`, `src/auth/authTool.ts`, `src/tools/results.ts` -signed one-time approval and stable errors.
- Create: `src/tools/binaryArtifacts.ts`; modify `src/tools/registry.ts`, `src/index.ts` -owner tool, redacted audit/health, tool inventory, cleanup.
- Create: `test/artifact-config.test.mjs`, `test/artifact-digest-signature.test.mjs`, `test/artifact-store.test.mjs`, `test/artifact-upload.test.mjs`, `test/artifact-url-import.test.mjs`, `test/artifact-materialize.test.mjs`, `test/artifact-manifest.test.mjs`, `test/binary-artifact-approval.test.mjs`, `test/binary-artifact-tool.test.mjs`, `test/binary-artifact-e2e.test.mjs`.
- Modify: `test/network-guard.test.mjs`, `test/web-fetch.test.mjs`, `test/tools-list.test.mjs`, `test/health-concurrency.test.mjs`, `test/security-auth.test.mjs`, `test/helpers/mcp-http-fixture.mjs`, `test/command-tool.test.mjs`, docs, and `.env.example`.
- Create: `test/owner-command-policy-e2e.test.mjs` - direct-owner dependency, compilation, and error-reporting coverage.

### Task 1: Commit the project-local ngrok layout

**Files:**

- Modify: `.gitignore`
- Modify: `scripts/start-feishu-mcp.ps1`
- Modify: `test/launcher.test.mjs`

- [ ] **Step 1: Inspect the existing, uncommitted layout change**

Run:

```powershell
git diff -- .gitignore scripts/start-feishu-mcp.ps1 test/launcher.test.mjs
git check-ignore -v tools/ngrok/ngrok.exe
```

Expected: the launcher resolves only `tools/ngrok/ngrok.exe`; that binary is ignored and no deleted sibling directory is referenced.

- [ ] **Step 2: Verify the launcher change**

Run:

```powershell
npm run build
node --test test/launcher.test.mjs
```

Expected: 9/9 tests pass without printing runtime secrets.

- [ ] **Step 3: Commit the independent baseline**

Run:

```powershell
git add .gitignore scripts/start-feishu-mcp.ps1 test/launcher.test.mjs
git commit -m "chore: keep bundled ngrok inside project"
```

Expected: this layout-only change is isolated before artifact implementation starts.

### Task 2: Establish contracts, configuration, concurrency, and shared network policy

**Files:**

- Create: `src/artifacts/types.ts`
- Modify: `src/config.ts`
- Modify: `src/tools/concurrency.ts`
- Modify: `src/security/networkGuard.ts`
- Create: `test/artifact-config.test.mjs`
- Modify: `test/network-guard.test.mjs`, `test/web-fetch.test.mjs`, `test/health-concurrency.test.mjs`

- [ ] **Step 1: Write failing configuration and policy tests**

Assert exact defaults: 100 MiB max bytes, 512 KiB decoded chunk, 15-minute upload TTL, 8 active uploads, 64 batch entries, and a data directory of `<APPROVAL_DATA_DIR>/binary-artifacts`. Probe and reject 1 GiB + 1 byte, 4 MiB + 1 byte chunk, 2 hours + 1 ms TTL, 33 uploads, 257 entries, and a data path outside approval data.

Assert health has an `artifact` lane but reveals no store path. Assert `artifact_import` rejects HTTP, user-info, loopback, private, carrier-grade NAT, link-local, unspecified, multicast, unique-local IPv6, and metadata addresses; assert a public HTTPS address succeeds. Assert current `web_fetch` tests retain their existing policy.

- [ ] **Step 2: Run tests to prove these contracts are absent**

Run:

```powershell
npm run build
node --test test/artifact-config.test.mjs test/network-guard.test.mjs test/web-fetch.test.mjs test/health-concurrency.test.mjs
```

Expected: FAIL because the artifact settings, lane, and policy choice do not exist.

- [ ] **Step 3: Define shared vocabulary and configuration**

Create `src/artifacts/types.ts`:

```ts
export type ArtifactClass = "project_asset" | "archive" | "executable";
export type ArtifactSourceKind = "url" | "upload";
export type ArtifactId = `sha256:\${string}`;

export interface ArtifactMetadata {
  version: 1; artifact: ArtifactId; sha256: string; size: number;
  displayName: string; declaredMediaType: string; detectedMediaType: string | null;
  class: ArtifactClass; createdAt: string; source: ArtifactSourceKind;
  urlOriginDigest?: string;
}
export interface UploadSession {
  version: 1; id: string; userId: string; displayName: string;
  declaredMediaType: string; expectedSize: number; expectedSha256: string | null;
  class: ArtifactClass; nextChunkIndex: number; writtenBytes: number;
  expiresAt: string; committedAt: string | null;
}
```

In `src/config.ts`, add `BINARY_ARTIFACT_MAX_BYTES`, `BINARY_ARTIFACT_CHUNK_BYTES`, `BINARY_ARTIFACT_UPLOAD_TTL_MS`, `BINARY_ARTIFACT_MAX_UPLOADS`, `BINARY_ARTIFACT_MAX_BATCH`, and resolved `BINARY_ARTIFACT_DATA_DIR`. Use `envBoundedPositiveInt`; reject a data dir whose relative path from resolved `APPROVAL_DATA_DIR` starts with `..` or is absolute.

- [ ] **Step 4: Add the artifact lane and a non-breaking network policy**

Implement these signatures:

```ts
export type ConcurrencyClass =
  "default" | "command" | "search" | "fetch" | "artifact" | "ungated";
export interface NetworkValidationOptions {
  policy?: "web_fetch" | "artifact_import";
}
export async function validateNetworkTarget(
  input: string | URL, options: NetworkValidationOptions = {},
): Promise<ValidatedNetworkTarget>;
```

Create the lane with `BINARY_ARTIFACT_MAX_UPLOADS` and include only counts/limit in `concurrencySummary`. Default network validation to `web_fetch` for compatibility. For `artifact_import`, require HTTPS and reject all forbidden address classes if any resolved address matches; retain DNS pinning in the returned address list.

- [ ] **Step 5: Verify and commit the foundation**

Run:

```powershell
npm run build
node --test test/artifact-config.test.mjs test/network-guard.test.mjs test/web-fetch.test.mjs test/health-concurrency.test.mjs
git add src/artifacts/types.ts src/config.ts src/tools/concurrency.ts src/security/networkGuard.ts test/artifact-config.test.mjs test/network-guard.test.mjs test/web-fetch.test.mjs test/health-concurrency.test.mjs
git commit -m "feat: add binary artifact foundations"
```

Expected: PASS; web fetch still follows its existing behavior.

### Task 3: Implement byte validation and immutable object storage

**Files:**

- Create: `src/artifacts/digest.ts`, `src/artifacts/signatures.ts`, `src/artifacts/store.ts`
- Modify: `src/artifacts/types.ts`
- Create: `test/artifact-digest-signature.test.mjs`, `test/artifact-store.test.mjs`

- [ ] **Step 1: Write failing validation and storage tests**

Use fixed PNG, JPEG, GIF, WebP, ZIP, PE, PDF, WAV, and Ogg byte fixtures. Assert recognized declared types match signatures; a PNG declared JPEG fails `BINARY_ARTIFACT_TYPE_MISMATCH`; an octet-stream project asset without expected digest fails; archive/executable with no expected digest fails. Assert malformed Base64 and an encoded chunk over the decoded limit fail without output allocation.

Store the same PNG twice and assert one object at artifact ID `sha256:<digest>`; corrupt stored content and assert `BINARY_ARTIFACT_STORE_FAILED`, never silent reuse. Assert serialized metadata contains no URL, query, target, identity, or internal path.

- [ ] **Step 2: Run the missing-module tests**

Run:

```powershell
npm run build
node --test test/artifact-digest-signature.test.mjs test/artifact-store.test.mjs
```

Expected: FAIL because byte helpers and store are absent.

- [ ] **Step 3: Implement digest and magic-byte helpers**

Implement:

```ts
export const SHA256_HEX = /^[a-f0-9]{64}$/;
export function parseSha256(value: string | undefined): string | null;
export function decodedBase64Length(value: string, maxBytes: number): number;
export function sha256File(filePath: string): { sha256: string; size: number };
export function artifactId(sha256: string): ArtifactId;
export function detectArtifactMediaType(prefix: Buffer): string | null;
export function validateArtifactType(input: {
  declaredMediaType: string; class: ArtifactClass; expectedSha256: string | null;
}, prefix: Buffer): { ok: true; detectedMediaType: string | null } |
  { ok: false; code: "BINARY_ARTIFACT_TYPE_MISMATCH" };
```

Read only signature-prefix bytes. Recognize PNG, JPEG, GIF, WebP, ZIP/JAR, PE, PDF, WAV, and Ogg. Never extract, parse archive entries, dynamically load, or execute the bytes.

- [ ] **Step 4: Implement exclusive staging and promotion**

In `BinaryArtifactStore`, use only these locations:

```text
binary-artifacts/objects/<digest[0:2]>/<digest>/content
binary-artifacts/objects/<digest[0:2]>/<digest>/metadata.json
binary-artifacts/uploads/<session-id>/content.partial
binary-artifacts/uploads/<session-id>/session.json
```

Create staging with `wx`, mode `0600`, and `O_NOFOLLOW` when available. `promoteStaging` must sync, check exact size/hash, inspect magic bytes, create the digest directory without links, atomically rename to `content`, atomically write/sync non-secret metadata, and verify existing content before deduplication. Export `createUploadStaging`, `promoteStaging`, `inspect`, `healthSummary`, and `cleanupExpiredUploads`; none may return storage paths.

- [ ] **Step 5: Verify and commit immutable storage**

Run:

```powershell
npm run build
node --test test/artifact-digest-signature.test.mjs test/artifact-store.test.mjs
git add src/artifacts/types.ts src/artifacts/digest.ts src/artifacts/signatures.ts src/artifacts/store.ts test/artifact-digest-signature.test.mjs test/artifact-store.test.mjs
git commit -m "feat: store verified binary artifacts"
```

Expected: PASS with streaming hash, deduplication, and corruption refusal.

### Task 4: Add sequential, identity-bound Base64 upload sessions

**Files:**

- Create: `src/artifacts/uploads.ts`
- Modify: `src/artifacts/store.ts`, `src/artifacts/types.ts`
- Create: `test/artifact-upload.test.mjs`

- [ ] **Step 1: Write failing upload lifecycle tests**

With 32-byte chunks and a controllable clock, begin a PNG session, append index 0 then 1, and commit to the expected artifact ID. Test invalid Base64, decoded chunk too large, index 2 before 1, duplicate 0, writes past expected size, wrong identity, final size mismatch, digest mismatch, commit replay, expiry, and startup cleanup. Assert inspection returns only state, session ID, expiry, next index, and bytes written.

- [ ] **Step 2: Run the lifecycle test**

Run:

```powershell
npm run build
node --test test/artifact-upload.test.mjs
```

Expected: FAIL because `ArtifactUploadService` is absent.

- [ ] **Step 3: Implement sequential session operations**

Implement:

```ts
export class ArtifactUploadService {
  begin(userId: string, request: UploadBeginRequest): UploadBeginResult;
  append(userId: string, sessionId: string, chunkIndex: number, base64: string): UploadChunkResult;
  commit(userId: string, sessionId: string): Promise<ArtifactCommitResult>;
  inspect(userId: string, sessionId: string): UploadInspection;
}
```

`begin` creates random UUID session metadata and an exclusive partial file after class/digest/size/count validation. `append` validates canonical Base64 and decoded size before decoding, enforces `chunkIndex === nextChunkIndex`, appends/syncs, then atomically records state. `commit` checks identity/expiry/size and delegates only once to `promoteStaging`; it marks success before return so replay is refused.

- [ ] **Step 4: Verify and commit uploads**

Run:

```powershell
npm run build
node --test test/artifact-upload.test.mjs
git add src/artifacts/uploads.ts src/artifacts/store.ts src/artifacts/types.ts test/artifact-upload.test.mjs
git commit -m "feat: support ordered binary artifact uploads"
```

Expected: PASS; chunk bytes and identities are never echoed or logged.

### Task 5: Implement safe streamed HTTPS URL importing

**Files:**

- Create: `src/artifacts/urlImport.ts`
- Modify: `src/security/networkGuard.ts`, `src/artifacts/store.ts`
- Create: `test/artifact-url-import.test.mjs`
- Modify: `test/web-fetch.test.mjs`

- [ ] **Step 1: Write failing URL and redaction tests**

Use controlled HTTPS endpoints and a DNS-validation seam. Verify requests use pinned lookup, GET, `accept-encoding: identity`, no caller cookies/headers; every redirect is revalidated. Reject downgrade, private redirect, credentials, too many redirects, declared/received oversized body, timeout, cancellation, and malformed response.

Use an attachment URL with a signed query. Assert response body, logs, stored metadata, errors, and health contain neither query value nor full URL; metadata retains only SHA-256 of the origin.

- [ ] **Step 2: Run the importer test**

Run:

```powershell
npm run build
node --test test/artifact-url-import.test.mjs test/web-fetch.test.mjs
```

Expected: FAIL because no importer exists.

- [ ] **Step 3: Implement a non-buffering importer**

Implement:

```ts
export interface UrlImportRequest {
  url: string; displayName: string; declaredMediaType: string;
  expectedSize: number | null; expectedSha256: string | null; class: ArtifactClass;
}
export async function importArtifactUrl(
  store: BinaryArtifactStore, request: UrlImportRequest, signal: AbortSignal,
): Promise<ArtifactCommitResult>;
```

Validate initial and redirected URLs with `artifact_import`; use `https.request` with validated address, TLS servername, identity encoding, bounded headers, timeout, and signal. Stream data into exclusive staging while counting bytes; remove only owned staging on failure. Compare declared length/expected size early and call promotion only after end. Derive and retain only origin digest. Do not alter `web_fetch` buffering or approval behavior.

- [ ] **Step 4: Verify and commit URL import**

Run:

```powershell
npm run build
node --test test/artifact-url-import.test.mjs test/web-fetch.test.mjs test/network-guard.test.mjs
git add src/artifacts/urlImport.ts src/security/networkGuard.ts src/artifacts/store.ts test/artifact-url-import.test.mjs test/web-fetch.test.mjs test/network-guard.test.mjs
git commit -m "feat: import binary artifacts from verified URLs"
```

Expected: PASS; redirect SSRF and signed-URL persistence are prevented.

### Task 6: Add atomic materialization and deterministic lock manifests

**Files:**

- Create: `src/artifacts/materialize.ts`, `src/artifacts/manifest.ts`
- Modify: `src/artifacts/types.ts`
- Create: `test/artifact-materialize.test.mjs`, `test/artifact-manifest.test.mjs`

- [ ] **Step 1: Write failing destination and manifest tests**

Use authorized and unauthorized roots. Reject out-of-root targets, symlink target/ancestor, refusal overwrite, traversal/absolute target, duplicate ID/target, malformed digest, mismatched size, and oversized manifest. Assert successful target bytes hash correctly; replacement backs up through existing trash semantics; forced copy/rename failure preserves original and removes only temporary output.

Assert sorted stable lock JSON and absent object returns `BINARY_ARTIFACT_SOURCE_REQUIRED` without target or manifest mutation.

- [ ] **Step 2: Run tests to verify absence**

Run:

```powershell
npm run build
node --test test/artifact-materialize.test.mjs test/artifact-manifest.test.mjs
```

Expected: FAIL because these modules do not exist.

- [ ] **Step 3: Implement materialization with existing directory proof**

Implement:

```ts
export async function materializeArtifact(request: {
  store: BinaryArtifactStore; artifact: ArtifactId; target: string;
  authorizedRoots: readonly CanonicalDirectoryRoot[];
  overwrite: "refuse" | "replace_with_backup";
}): Promise<MaterializeResult>;
```

Resolve target under both logical/physical authorized roots; reject links. Open source no-follow, create exclusive same-directory temp, copy in fixed buffers, sync, hash verify, and rename. On replacement use `moveToTrash` and restore original if rename fails. This helper never calls execution, import, or `write_file`.

- [ ] **Step 4: Implement manifest parsing and planning**

Implement version-1 `.feishu-artifacts.lock.json` parsing and serialization. Validate positive sizes, digest IDs, classes, media type, normalized unique relative targets, and max batch. Sort cloned entries by `id`, add a final newline, and plan every entry before mutation as `unchanged`, `materialize`, or `source_required`.

- [ ] **Step 5: Verify and commit**

Run:

```powershell
npm run build
node --test test/artifact-materialize.test.mjs test/artifact-manifest.test.mjs
git add src/artifacts/materialize.ts src/artifacts/manifest.ts src/artifacts/types.ts test/artifact-materialize.test.mjs test/artifact-manifest.test.mjs
git commit -m "feat: materialize verified artifact manifests"
```

Expected: PASS with atomic target changes and reproducible URL-free manifests.

### Task 7: Add exact owner approvals and legacy Aily fallback

**Files:**

- Modify: `src/security/approvalState.ts`, `src/auth/authTool.ts`, `src/tools/results.ts`
- Create: `src/security/binaryArtifactApproval.ts`
- Create: `test/binary-artifact-approval.test.mjs`
- Modify: `test/approval-elicitation.test.mjs`

- [ ] **Step 1: Write failing modern and legacy approval tests**

For modern MCP, assert only `allow_once`/ `deny` are offered and unchanged signed retry works. For legacy Aily, assert `BINARY_ARTIFACT_APPROVAL_REQUIRED` includes a challenge, expiry, action, origin, bytes, and decisions. Submit via `auth.binaryArtifactApproval`, then retry unchanged. Assert changed URL origin, digest, target root, byte total, action, non-owner, expiry, denial, and nonce replay fail before storage mutation.

- [ ] **Step 2: Run approval tests**

Run:

```powershell
npm run build
node --test test/binary-artifact-approval.test.mjs test/approval-elicitation.test.mjs
```

Expected: FAIL because artifact approval state does not exist.

- [ ] **Step 3: Add exact signed state and approval helper**

Add to `approvalState.ts`:

```ts
export interface BinaryArtifactApprovalStatePayload {
  version: 1; kind: "binary_artifact"; userId: string; action: string;
  argsDigest: string; sourceOriginDigest: string | null;
  destinationRootsDigest: string | null; plannedBytes: number;
  nonce: string; expiresAt: string;
}
```

The helper uses existing argument digesting and nonce consumption, owner identity, and `APPROVAL_TIMEOUT_MS`. Modern elicitation and legacy challenge display only action, redacted filename, class, supplied digest, bytes, HTTPS origin, and root count. Legacy allow-once stores one exact short-lived match; no session/permanent grant exists.

- [ ] **Step 4: Extend auth and stable errors**

Add:

```ts
binaryArtifactApproval: z.object({
  challenge: z.string().min(1).max(16_384),
  decision: z.enum(["allow_once", "deny"]),
}).optional()
```

Add exactly these stable errors: `BINARY_ARTIFACT_APPROVAL_REQUIRED`, `BINARY_ARTIFACT_NOT_FOUND`, `BINARY_ARTIFACT_UPLOAD_NOT_FOUND`, `BINARY_ARTIFACT_UPLOAD_EXPIRED`, `BINARY_ARTIFACT_UPLOAD_ORDER`, `BINARY_ARTIFACT_TOO_LARGE`, `BINARY_ARTIFACT_SIZE_MISMATCH`, `BINARY_ARTIFACT_DIGEST_MISMATCH`, `BINARY_ARTIFACT_TYPE_MISMATCH`, `BINARY_ARTIFACT_SOURCE_DENIED`, `BINARY_ARTIFACT_SOURCE_REQUIRED`, `BINARY_ARTIFACT_DESTINATION_DENIED`, `BINARY_ARTIFACT_STORE_FAILED`, `BINARY_ARTIFACT_MATERIALIZE_FAILED`, and `BINARY_ARTIFACT_MANIFEST_INVALID`. Messages/details must omit bytes, Base64, URL/query, identity, paths, and tokens.

- [ ] **Step 5: Verify and commit approvals**

Run:

```powershell
npm run build
node --test test/binary-artifact-approval.test.mjs test/approval-elicitation.test.mjs
git add src/security/approvalState.ts src/security/binaryArtifactApproval.ts src/auth/authTool.ts src/tools/results.ts test/binary-artifact-approval.test.mjs test/approval-elicitation.test.mjs
git commit -m "feat: approve binary artifact actions once"
```

Expected: PASS; both approval paths are owner-only and one-time.

### Task 8: Register the strict MCP tool, batch orchestration, health, and E2E

**Files:**

- Create: `src/tools/binaryArtifacts.ts`
- Modify: `src/tools/registry.ts`, `src/index.ts`
- Create: `test/binary-artifact-tool.test.mjs`, `test/binary-artifact-e2e.test.mjs`
- Modify: `test/tools-list.test.mjs`, `test/health-concurrency.test.mjs`, `test/security-auth.test.mjs`, `test/helpers/mcp-http-fixture.mjs`

- [ ] **Step 1: Write failing strict-schema and HTTP E2E tests**

Fixture: owner identity, owner directory fallback, temporary artifact data, and controlled public URL source. Assert tools/list and health are exactly 31 and only new tool is `manage_binary_artifact`; non-owner/missing identity returns `OWNER_REQUIRED` before store details.

Cover `inspect`, `import_url`, `upload_begin`, `upload_chunk`, `upload_commit`, `materialize`, `sync_manifest`. Reject unknown fields/actions, invalid chunk length, 65 bindings, executable/archive digest omission, and execution-shaped arguments. Cover legacy/modern approval, 18 PNG batch with one exact approval, idempotent re-sync, changed source/digest/target rejection, expiry recovery, and proof PE/JAR/ZIP never reaches child-process/module/archive APIs.

- [ ] **Step 2: Run E2E tests to prove unregistered state**

Run:

```powershell
npm run build
node --test test/binary-artifact-tool.test.mjs test/binary-artifact-e2e.test.mjs test/tools-list.test.mjs test/health-concurrency.test.mjs test/security-auth.test.mjs
```

Expected: FAIL because tool inventory remains 30.

- [ ] **Step 3: Implement strict dispatcher and action schema**

Create strict discriminated Zod actions for `inspect`, `import_url`, `upload_begin`, `upload_chunk`, `upload_commit`, `materialize`, and `sync_manifest`; use `.strict()` for every member. Cap chunk text before decode using encoded chunk limit. Register only `manage_binary_artifact`, then require configured `OWNER_USER_ID` equal to request identity. Use `runTool` with `concurrency: "artifact"` and a redacted artifact subject.

Mutating imports/uploads/materializations first acquire exact authorization. Chunks and commit continue only approved, identity-bound sessions. Directory authorization precedes destination approval. Keep every original argument unchanged across legacy retry.

- [ ] **Step 4: Implement batch plan execution and server integration**

`sync_manifest` parses/plans every entry before mutation, accepts source binding only for currently missing matching objects, computes one bytes/root/action digest, requests one approval, imports missing objects, materializes, then writes sorted manifest only after all targets are correct. Report per-item `unchanged`, `materialized`, `source_required`, or `failed`; clean only operation staging.

In `index.ts`, create one store/upload service, add the 31st tool to `TOOL_NAMES`, register it after web fetch, run owned expired-upload cleanup at startup/hourly, add only store schema/count/limits to health, and add the exact Aily protocol: display challenge, wait owner allow-once/deny, submit `auth.binaryArtifactApproval`, retry unchanged.

- [ ] **Step 5: Verify and commit the public contract**

Run:

```powershell
npm run build
node --test test/binary-artifact-tool.test.mjs test/binary-artifact-e2e.test.mjs test/tools-list.test.mjs test/health-concurrency.test.mjs test/security-auth.test.mjs
git add src/tools/binaryArtifacts.ts src/tools/registry.ts src/index.ts test/binary-artifact-tool.test.mjs test/binary-artifact-e2e.test.mjs test/tools-list.test.mjs test/health-concurrency.test.mjs test/security-auth.test.mjs test/helpers/mcp-http-fixture.mjs
git commit -m "feat: expose managed binary artifact pipeline"
```

Expected: PASS; all 18 valid PNGs materialize byte-for-byte after one approval and no imported content executes.

### Task 9: Enable direct owner build verification through the existing command tool

**Files:**

- Modify: `src/config.ts: command-policy settings`
- Modify: `src/tools/command.ts: owner direct-policy branch`
- Modify: `src/index.ts: command capability instructions and redacted health`
- Modify: `.env.example`
- Modify: `test/directory-config.test.mjs`, `test/command-tool.test.mjs`, `test/health-concurrency.test.mjs`
- Create: `test/owner-command-policy-e2e.test.mjs`

- [ ] **Step 1: Write failing policy and compiler-verification tests**

Add probes that assert the default is `OWNER_COMMAND_POLICY=approval`, that
`OWNER_COMMAND_POLICY=direct` without `OWNER_USER_ID` exits non-zero, and
that any value other than `approval` or `direct` is rejected.

Start the MCP HTTP fixture with an owner, a directory-authorized temporary
project, and `OWNER_COMMAND_POLICY=direct`. Use a local package fixture with
`"verify": "node -e \\"process.stdout.write('verified')\\"``. Assert the
owner's `execute_command` calls for `npm run verify` and `npx tsc
--noEmit` finish without `input_required` or legacy approval. Assert the
result has `ok: true`, exit code, duration, and bounded output. Add a
command that exits 2 and assert its stderr and exit code return for automatic
repair.

Assert a non-owner still receives normal command approval; an owner outside
the authorized root still receives directory authorization; `approval`
retains normal command approval; the protected approval-data directory stays
denied; and tools/list remains exactly 31 because no new shell tool is added.

- [ ] **Step 2: Run the test to prove direct owner behavior is absent**

Run:

```powershell
npm run build
node --test test/directory-config.test.mjs test/command-tool.test.mjs test/owner-command-policy-e2e.test.mjs test/health-concurrency.test.mjs
```

Expected: FAIL because `OWNER_COMMAND_POLICY` is not parsed and the owner
still enters the per-command approval flow.

- [ ] **Step 3: Implement owner direct policy while retaining boundaries**

In `src/config.ts`, add next to `GIT_COMMAND_POLICY`:

```ts
export type OwnerCommandPolicy = "approval" | "direct";
export const OWNER_COMMAND_POLICY: OwnerCommandPolicy = envEnum(
  "OWNER_COMMAND_POLICY", ["approval", "direct"] as const, "approval",
);
if (OWNER_COMMAND_POLICY === "direct" && !OWNER_USER_ID) {
  throw new Error("OWNER_USER_ID is required when OWNER_COMMAND_POLICY is direct");
}
```

In `executeCommand`, keep directory authorization, protected-data checks,
timeout/output limits, cancellation, process runner, command concurrency, and
all Git-confirmation logic. After those checks calculate:

```ts
const ownerDirect = OWNER_COMMAND_POLICY === "direct" &&
  OWNER_USER_ID.length > 0 && userId === OWNER_USER_ID;
```

Skip only the normal `requestApproval` branch when `ownerDirect` is true.
Do not bypass a `confirmation_required` Git operation under
`GIT_COMMAND_POLICY=soft_owner`; do not treat missing or non-owner identity
as direct.

Update the tool description and server instructions: an owner with direct
policy may run `npm install`, `npm run build`, `npx tsc --noEmit`, and
tests inside an authorized project root. Add only
`ownerCommandPolicy: OWNER_COMMAND_POLICY` to the existing redacted health
approval summary.

- [ ] **Step 4: Verify and commit direct build verification**

Run:

```powershell
npm run build
node --test test/directory-config.test.mjs test/command-tool.test.mjs test/owner-command-policy-e2e.test.mjs test/health-concurrency.test.mjs
git add src/config.ts src/tools/command.ts src/index.ts .env.example test/directory-config.test.mjs test/command-tool.test.mjs test/owner-command-policy-e2e.test.mjs test/health-concurrency.test.mjs
git commit -m "feat: allow owner build verification commands"
```

Expected: direct owner compilation works without a second approval, while
authentication, directory confinement, timeout/output limits, cancellation,
and high-impact Git confirmation remain active.

### Task 10: Document and release-verify the feature

**Files:**

- Modify: `.env.example`, `README.md`, `docs/aily-integration-guide.md`, `docs/local-development-environment.md`
- Modify: `test/development-docs.test.mjs` if it asserts tool count or capability text

- [ ] **Step 1: Write the operator contract**

Add:

```dotenv
BINARY_ARTIFACT_DATA_DIR=
BINARY_ARTIFACT_MAX_BYTES=104857600
BINARY_ARTIFACT_CHUNK_BYTES=524288
BINARY_ARTIFACT_UPLOAD_TTL_MS=900000
BINARY_ARTIFACT_MAX_UPLOADS=8
BINARY_ARTIFACT_MAX_BATCH=64
OWNER_COMMAND_POLICY=direct
```

Document that `write_file` remains UTF-8 text-only with executable extension blocks. Explain actions, hashes, source-required restore, lock manifests, approval fallback, and no-execution/no-extraction/no-install boundary. Document that direct policy removes only the configured owner's second command approval; package lifecycle scripts and network activity are not reversible, while authentication, authorized project roots, timeouts, output bounds, cancellation, and Git confirmation remain. State Git LFS, releases, and reviewed package catalog are separate distribution/provisioning concerns.

- [ ] **Step 2: Run focused docs and contract checks**

Run:

```powershell
npm run build
node --test test/development-docs.test.mjs test/tools-list.test.mjs test/health-concurrency.test.mjs
```

Expected: PASS with 31 tools and no unsupported binary-write claim.

- [ ] **Step 3: Run complete regression and security checks**

Run:

```powershell
npm test
dotnet test broker\FeishuMcp.AdminBroker.Tests\FeishuMcp.AdminBroker.Tests.csproj
python test\e2e_test.py
npm audit --omit=dev
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\scan-development-secrets.ps1
git diff --check
```

Expected: Node, Broker, Python, audit, secret scan, and whitespace checks pass.

- [ ] **Step 4: Commit documentation and confirm handoff state**

Run:

```powershell
git add .env.example README.md docs/aily-integration-guide.md docs/local-development-environment.md test/development-docs.test.mjs
git commit -m "docs: explain binary artifact pipeline"
git status --short --branch
```

Expected: clean feature branch with focused, reviewable commits.

## Plan self-review

- Spec coverage: Tasks 1 and 2 cover the local runtime baseline, limits, protected storage, concurrency, and network policy. Tasks 3 through 5 cover streaming validation, immutable store, chunks, URL import, SSRF/redirect safety, cancellation, and redaction. Task 6 covers atomic materialization and lock manifests. Task 7 covers exact owner approval, modern elicitation, legacy Aily fallback, expiry, and replay. Task 8 covers strict action schema, 31-tool inventory, batch behavior, health, cleanup, audit boundary, and E2E. Task 9 makes existing command execution discoverable and direct for the configured owner without adding a new shell endpoint. Task 10 covers startup/operator documentation and full regression.
- Placeholder scan: every task names concrete files, exported interfaces or required behavior, focused commands, expected output, and a commit.
- Type consistency: `ArtifactClass`, `ArtifactId`, `ArtifactMetadata`, `UploadSession`, `BinaryArtifactStore`, `ArtifactUploadService`, `BinaryArtifactApprovalStatePayload`, `BINARY_ARTIFACT_*`, and `manage_binary_artifact` use the same names throughout.
