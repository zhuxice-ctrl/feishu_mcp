import assert from "node:assert/strict";
import test from "node:test";

import { toolError } from "../dist/tools/results.js";

test("legacy directory errors preserve structured approval details", () => {
  const result = toolError(
    "DIRECTORY_APPROVAL_REQUIRED",
    "approval required",
    true,
    { directoryApproval: { challenge: "opaque", decisions: ["allow_once"] } },
  );
  assert.deepEqual(JSON.parse(result.content[0].text), {
    ok: false,
    code: "DIRECTORY_APPROVAL_REQUIRED",
    message: "approval required",
    retryable: true,
    directoryApproval: { challenge: "opaque", decisions: ["allow_once"] },
  });
});
