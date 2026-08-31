# Resumable Text Transfer Design

## Goal

Allow an authenticated owner to write large UTF-8 source files through MCP requests that remain below the upstream request-size limit, without weakening filesystem authorization or introducing generic command execution.

## Chosen approach

Add a new owner-only `manage_text_transfer` tool. It is deliberately separate from `write_file` and `edit_file`, which keep their current single-request contracts for small edits. The tool exposes four actions: `begin`, `append`, `inspect`, and `commit`.

Each `append` request carries at most 48 KiB of UTF-8 text. The service writes ordered chunks to a private staging file and persists only the session metadata needed to resume. `commit` verifies the declared byte length and mandatory SHA-256 digest, then uses the existing atomic-write-and-trash behavior to replace the destination.

## Boundaries and safety

- The tool is owner-only and still requires the normal authenticated request identity.
- `begin` authorizes the destination with the existing directory, symlink, sensitive-file, and consent path guards; the resolved path is private session metadata and is never returned by `inspect`.
- `commit` revalidates the stored target with the same path guards before replacing it. A revoked directory grant or a newly-sensitive target therefore cannot be bypassed by an old upload session.
- Sessions are isolated by owner identity, expire after a bounded TTL, enforce a bounded number of active sessions and total file size, and are cleaned up on expiration or after a successful commit.
- No chunk, file content, destination path, hash, or error detail is emitted to audit logs beyond the existing tool operation record. The tool never executes, extracts, or interprets uploaded text.

## Data flow

`begin(path, expectedBytes, expectedSha256)` validates and authorizes the target, creates a UUID staging directory under `APPROVAL_DATA_DIR/text-transfers`, and returns a session ID plus chunk limit. `append(sessionId, chunkIndex, content)` only accepts the exact next index and appends validated UTF-8 bytes. `inspect(sessionId)` returns safe progress metadata. `commit(sessionId)` checks length and digest, performs an atomic replacement with a `.trash` backup, removes staging state, and returns byte-count plus digest.

## Error behavior

The service reports stable structured error codes for missing/expired sessions, another owner's session, sequence errors, oversized or malformed chunks, exceeded expected size, size mismatch, and digest mismatch. Tool-level path authorization failures continue using the existing MCP error responses. A failed commit leaves the original target intact.

## Verification

Unit tests cover a 167 KiB UTF-8 transfer, resume inspection, owner isolation, sequence and size rejection, expiry, digest mismatch, and failed-commit preservation. MCP integration tests prove destination authorization remains required and the tool is advertised in the inventory. The complete TypeScript build and test suite are the final gate.
