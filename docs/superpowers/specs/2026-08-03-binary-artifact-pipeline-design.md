# Binary Artifact Pipeline Design

## Purpose

The MCP currently treats `write_file` as a UTF-8 text operation. Passing
Base64 through that tool writes the encoded text verbatim, while blocked
script and executable extensions prevent an agent from repairing the result by
creating and running a decoder. This is correct behavior for the text tool, but
it leaves the product without a native path for images, archives, wrapper JARs,
executables, and other binary assets.

This feature adds an owner-scoped binary artifact pipeline. It transfers raw
bytes through typed MCP operations, verifies and stores them in a
content-addressed repository, then materializes verified objects into an
authorized project directory. It never requires the user to run a terminal
command and never broadens `write_file` or arbitrary command execution.

## Scope

Version 1 supports:

- importing an artifact from an HTTPS URL, including a short-lived attachment
  URL supplied by Aily;
- uploading an artifact through ordered Base64 chunks when no downloadable URL
  exists;
- validating size, SHA-256, declared type, and selected file signatures;
- storing verified bytes once in an internal content-addressed object store;
- atomically materializing a stored object into an owner-authorized project;
- inspecting upload sessions, stored objects, and project materializations;
- batching up to 64 project assets under one exact approval request;
- project lock metadata that records target, digest, byte size, media type, and
  artifact identity without recording secret source URLs;
- a signed conversational approval fallback for Aily clients that cannot
  render MCP `inputRequired`.

Version 1 does not:

- execute an imported binary;
- extract an archive;
- provide arbitrary shell, PowerShell, or script execution;
- act as a public binary hosting service;
- upload artifacts to GitHub Releases, Git LFS, or third-party storage;
- silently download a mutable “latest” tool release;
- commit third-party binaries to Git.

Toolchain installation remains governed by the reviewed development package
catalog and administrator broker. The artifact pipeline may supply a pinned,
hash-verified file to an unprivileged project-local location, but it does not
replace privileged installation policy.

## Approaches considered

### Native artifact pipeline — selected

The server owns byte transfer, streaming validation, atomic storage, and
materialization. This gives the protocol explicit binary semantics and allows
URL imports to bypass model context entirely. Chunk upload remains available
for generated assets that have no URL.

### Make `write_file` accept Base64

This appears smaller but creates ambiguous content semantics, encourages huge
model messages, makes partial writes difficult to recover, and risks decoding
ordinary text unexpectedly. It also does not solve caching, provenance,
deduplication, atomic materialization, or executable policy.

### Generate a decoder script or expose arbitrary commands

This depends on the same script and command restrictions that correctly caused
the reported failure. It expands the attack surface and makes success dependent
on host shell behavior instead of a stable MCP contract.

### Store every binary in Git, Git LFS, or a repository release

Those are distribution choices, not a local transfer protocol. They require
hosting, quotas, clients, and permission to redistribute third-party software.
The artifact pipeline can consume a stable release URL, but does not make remote
hosting a prerequisite.

## Public tool contract

Add one owner-only MCP tool named `manage_binary_artifact`. A single tool keeps
the public inventory compact while using a strict discriminated action schema.

### `inspect`

Inputs:

- optional artifact SHA-256;
- optional upload session ID;
- optional project manifest path.

Returns redacted status only: existence, state, media type, byte size, digest,
target state, expiry, and stable error codes. Internal store paths and source
URLs are never returned.

### `import_url`

Inputs:

- exact HTTPS URL;
- display filename;
- declared media type;
- expected byte size when known;
- expected SHA-256 when known;
- artifact class: `project_asset`, `archive`, or `executable`.

The server streams the response into a staging file. It never buffers the whole
artifact in memory and never emits the URL to logs. URL imports require exact
single-use owner approval. The approval display shows only HTTPS origin,
redacted filename, declared class, expected size, and expected digest.

Expected SHA-256 is optional for non-executable project assets and mandatory for
archives and executables. Mutable redirects, HTTPS downgrade, credentials in
the authority component, loopback/private/link-local destinations, and origins
that fail the shared network policy are denied. Each redirect is validated
before following it.

### `upload_begin`

Inputs:

- display filename;
- declared media type;
- expected byte size;
- optional expected SHA-256;
- artifact class.

Returns an opaque upload session ID, fixed decoded chunk limit, expiry, and next
chunk index. Creation requires exact single-use owner approval.

### `upload_chunk`

Inputs:

- upload session ID;
- zero-based chunk index;
- Base64 chunk.

The server decodes the chunk directly to the staging file. It rejects invalid
Base64, duplicate or out-of-order indexes, decoded chunks over the configured
limit, writes that exceed the expected size, expired sessions, wrong identity,
and replay after commit. Chunk data is never logged or echoed.

### `upload_commit`

Inputs:

- upload session ID.

The server closes and synchronizes the staging file, verifies exact byte size,
computes SHA-256, compares any expected digest, validates selected magic bytes,
and atomically promotes the object into the content-addressed store. It returns
a stable artifact ID derived from the digest plus non-secret metadata.

### `materialize`

Inputs:

- artifact ID;
- authorized destination path;
- overwrite mode: `refuse` or `replace_with_backup`;
- optional project lock-file path.

The destination must pass the existing directory authorization and real-path
confinement checks. The server stages a same-directory copy, synchronizes it,
verifies the final digest, and atomically replaces the destination. Replacement
uses the existing trash/backup semantics. Materialization never executes or
loads the artifact.

### `sync_manifest`

Inputs:

- an authorized manifest path;
- up to 64 source bindings supplied only for entries currently missing from the
  object store.

The committed project manifest contains target, digest, byte size, media type,
and artifact class. It does not contain bearer tokens, signed attachment query
parameters, or other credentials. The call calculates one exact plan, requests
one approval for the complete batch, imports missing objects, materializes all
verified targets, and reports a per-item result. The operation is idempotent:
already correct targets are unchanged.

No remove action is exposed in Version 1. Expired upload sessions are cleaned
automatically. Content-addressed object garbage collection remains a local
maintenance operation until retention and reference tracking have a separate
approved design.

## Store layout

Add `BINARY_ARTIFACT_DATA_DIR`, defaulting to
`<APPROVAL_DATA_DIR>/binary-artifacts`. Startup fails if it resolves outside
`APPROVAL_DATA_DIR`.

The layout is:

```text
binary-artifacts/
├── objects/
│   └── <sha256[0:2]>/
│       └── <sha256>/
│           ├── content
│           └── metadata.json
└── uploads/
    └── <session-id>/
        ├── content.partial
        └── session.json
```

Object metadata contains:

- schema version;
- SHA-256 and byte size;
- normalized display filename;
- declared and detected media types;
- artifact class;
- creation timestamp;
- source kind (`url` or `upload`);
- URL origin digest when applicable.

Metadata never contains the full URL, request headers, query parameters,
identity, project target path, or credential material.

The artifact ID is `sha256:<64 lowercase hexadecimal characters>`. Object
creation is deduplicated and idempotent. If the object already exists, the
server verifies its content and metadata before reuse.

## Limits and configuration

Add validated configuration:

- `BINARY_ARTIFACT_MAX_BYTES`: default 100 MiB, maximum 1 GiB;
- `BINARY_ARTIFACT_CHUNK_BYTES`: default 512 KiB decoded, maximum 4 MiB;
- `BINARY_ARTIFACT_UPLOAD_TTL_MS`: default 15 minutes, maximum 2 hours;
- `BINARY_ARTIFACT_MAX_UPLOADS`: default 8 active owner sessions, maximum 32;
- `BINARY_ARTIFACT_MAX_BATCH`: default 64, maximum 256;
- `BINARY_ARTIFACT_DATA_DIR`: protected store path.

The MCP input schema also limits encoded chunk length before decoding.
Concurrency uses a dedicated bounded artifact lane so uploads cannot exhaust
normal command, search, fetch, or global capacity.

## Type validation

Version 1 recognizes these signatures where applicable:

- PNG, JPEG, GIF, WebP;
- ZIP/JAR;
- Windows PE executable;
- PDF;
- WAV and Ogg.

A declared recognized type must match its signature. Unknown
`application/octet-stream` project assets are allowed only with an expected
SHA-256 and explicit approval. Executable and archive classes always require an
expected digest. Validation never interprets, extracts, dynamically loads, or
executes file contents.

File extensions are advisory. Signature, declared class, digest, source policy,
and destination authorization make the decision. Existing blocked-extension
rules remain unchanged for `write_file`.

## Network safety

Extract the URL/IP/redirect checks currently used by `web_fetch` into a shared
network-policy module without changing existing web-fetch behavior.

Artifact URL imports additionally enforce:

- HTTPS only;
- no embedded username/password;
- no caller-provided headers or cookies;
- bounded redirects;
- bounded response headers and streamed body;
- early rejection when declared or received size exceeds the configured limit;
- cancellation and timeout propagation;
- no response body in errors or audit logs.

Short-lived attachment URLs may contain query credentials. They are accepted
only as opaque inputs to the fetcher, redacted before any error construction,
and never persisted beyond the active request.

## Authorization and approval

The entire tool is owner-only and requires `OWNER_USER_ID`.

All project destinations first use existing directory authorization. Import,
upload creation, materialization, and manifest synchronization require an exact
single-use operation approval. Upload chunks and commit continue only the
already approved, identity-bound upload session.

For clients with MCP elicitation, use the existing signed
`inputRequired` flow. For Aily clients without elicitation, return
`BINARY_ARTIFACT_APPROVAL_REQUIRED` with a signed short-lived challenge that
binds action, owner, arguments digest, source-origin digest, destination-root
digest, planned byte total, and nonce. Aily must display the redacted plan, wait
for an explicit allow-once or deny response, submit the decision through
`auth.binaryArtifactApproval`, then retry the original call unchanged.

Challenges are one-time, expire with `APPROVAL_TIMEOUT_MS`, cannot authorize
changed inputs, and cannot grant session or permanent authorization.

## Atomicity and recovery

Every incoming byte stream writes to a private staging file created with
exclusive semantics. Commit performs:

1. close and synchronize staging data;
2. verify expected and actual size;
3. compute and verify SHA-256;
4. validate signature/type policy;
5. create the object directory without following links;
6. atomically rename the staging file into the object;
7. synchronize and write non-secret metadata atomically.

Materialization writes a same-directory temporary file and verifies its digest
before rename. Batch sync plans every item before mutation. On failure, it
removes only staging files owned by the current operation and reports per-item
state; verified content-addressed objects remain reusable.

On startup, expired incomplete upload sessions are removed only after verifying
that their canonical paths remain inside the configured uploads directory.
Active or recently updated sessions are retained.

## Project manifest

Use a committed file named `.feishu-artifacts.lock.json`:

```json
{
  "version": 1,
  "artifacts": [
    {
      "id": "monster-001",
      "artifact": "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
      "size": 183421,
      "mediaType": "image/png",
      "class": "project_asset",
      "target": "assets/monsters/001.png"
    }
  ]
}
```

Targets are relative, normalized, unique, free of traversal, and resolved under
the manifest's authorized project root. Entries are sorted by ID for stable
diffs. The manifest proves expected content but does not host it. A fresh clone
can restore from stable URLs supplied to `sync_manifest`, an Aily attachment,
an upload, or a future configured artifact registry.

## Existing binary mechanisms

The existing development-task artifact collector and Android binary stdout sink
remain output mechanisms for trusted local processes. They should reuse shared
digest and signature helpers where useful, but they are not converted into
network upload sessions.

The current project-local ngrok relocation is retained as groundwork:

- `tools/ngrok/` remains Git-ignored;
- the launcher resolves the project-local binary;
- a later implementation task may express pinned ngrok acquisition through the
  artifact/catalog path after an immutable official source and redistribution
  policy are documented.

## Stable errors

Add specific errors including:

- `BINARY_ARTIFACT_APPROVAL_REQUIRED`;
- `BINARY_ARTIFACT_NOT_FOUND`;
- `BINARY_ARTIFACT_UPLOAD_NOT_FOUND`;
- `BINARY_ARTIFACT_UPLOAD_EXPIRED`;
- `BINARY_ARTIFACT_UPLOAD_ORDER`;
- `BINARY_ARTIFACT_TOO_LARGE`;
- `BINARY_ARTIFACT_SIZE_MISMATCH`;
- `BINARY_ARTIFACT_DIGEST_MISMATCH`;
- `BINARY_ARTIFACT_TYPE_MISMATCH`;
- `BINARY_ARTIFACT_SOURCE_DENIED`;
- `BINARY_ARTIFACT_DESTINATION_DENIED`;
- `BINARY_ARTIFACT_STORE_FAILED`;
- `BINARY_ARTIFACT_MATERIALIZE_FAILED`;
- `BINARY_ARTIFACT_MANIFEST_INVALID`.

Errors expose no bytes, Base64, full URLs, query values, internal paths, or raw
identities.

## Observability

Health adds only:

- artifact store schema version;
- active upload count;
- stored object count;
- configured byte/chunk/batch limits.

Audit events record action, outcome, artifact digest prefix, declared class,
byte count, and source-origin digest. They do not record raw filenames when
sensitive, Base64, URLs, project paths, upload tokens, user IDs, or store paths.

## Testing

Unit tests cover:

- configuration bounds and protected store path;
- Base64 validation, decoded-size accounting, ordering, replay, expiry, and
  identity isolation;
- streaming hash, size, and signature validation;
- content-addressed deduplication and corruption refusal;
- manifest schema, stable ordering, duplicate/traversal rejection;
- network policy, redirect revalidation, SSRF denial, URL redaction;
- exact signed approval matching, expiry, denial, and nonce replay;
- atomic materialization, overwrite backup, cancellation, and cleanup.

HTTP MCP end-to-end tests cover both modern elicitation and conversational Aily
fallback:

- URL import to materialization;
- chunked PNG upload to materialization;
- an 18-image batch with one exact approval;
- changed URL, digest, target, or batch denial;
- wrong owner and missing identity denial;
- interrupted upload resumption and expiry cleanup;
- non-execution of PE/JAR/ZIP artifacts;
- health and logs contain no source URLs, query strings, Base64, paths,
  identities, or secrets;
- the public tool inventory increases from 30 to exactly 31;
- all existing text file, command, development-task, Broker, and Python tests
  remain green.

## Acceptance criteria

The feature is complete when an Aily conversation can receive 18 generated PNG
assets without asking the user to run a terminal command, materialize them as
valid PNG bytes under an approved project directory, and reproduce their exact
SHA-256 values from a committed lock manifest.

A clean clone with missing objects must receive a structured “source required”
result, then restore those objects from supplied stable URLs or uploads without
changing the manifest or running a script.

An attempted executable import must remain inert, require an expected digest
and exact approval, and never become executable through this tool alone.
