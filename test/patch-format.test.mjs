import assert from "node:assert/strict";
import test from "node:test";

process.env.AUTH_MODE = "none";
const {
  parseStructuredPatch,
  applyStructuredHunks,
  parseUnifiedDiff,
  applyUnifiedHunks,
} = await import("../dist/tools/patchFormat.js");

test("parses structured add, update, move, and delete operations", () => {
  const operations = parseStructuredPatch(`*** Begin Patch
*** Add File: new.txt
+new
*** Update File: old.txt
*** Move to: moved.txt
@@ anchor
-old
+updated
*** Delete File: gone.txt
*** End Patch`);
  assert.deepEqual(operations.map((operation) => operation.kind), ["add", "update", "delete"]);
  assert.equal(operations[1].moveTo, "moved.txt");
});

test("applies a uniquely located structured hunk", () => {
  const output = applyStructuredHunks("before\nold\nafter\n", [{
    anchor: "",
    lines: [
      { type: "context", content: "before" },
      { type: "remove", content: "old" },
      { type: "add", content: "new" },
      { type: "context", content: "after" },
    ],
  }], "file.txt");
  assert.equal(output, "before\nnew\nafter\n");
});

test("rejects an ambiguous structured hunk without a unique anchor", () => {
  assert.throws(() => applyStructuredHunks("x\nold\nx\nold\n", [{
    anchor: "",
    lines: [{ type: "remove", content: "old" }, { type: "add", content: "new" }],
  }], "file.txt"), /matches 2 locations/);
});

test("parses and applies a traditional unified diff", () => {
  const hunks = parseUnifiedDiff(`--- a/file.txt
+++ b/file.txt
@@ -1,2 +1,2 @@
 one
-two
+changed
`);
  assert.equal(applyUnifiedHunks("one\ntwo\n", hunks), "one\nchanged\n");
});

test("rejects unified hunk count mismatches", () => {
  assert.throws(() => parseUnifiedDiff("@@ -1,2 +1,2 @@\n-old\n+new\n"), /line counts/);
});
