import assert from "node:assert/strict";
import test from "node:test";

const { terminateProcessTree } = await import("../dist/development/tasks/processTree.js");

test("Windows cancellation uses taskkill on the verified PID and whole tree", async () => {
  const calls = [];
  const termination = terminateProcessTree(43210, {
    platform: "win32",
    graceMs: 5,
    spawnHelper(executable, args, options) {
      calls.push({ executable, args, options });
      return { on() {}, unref() {} };
    },
    kill() {
      throw new Error("process.kill must not detach the parent before taskkill captures the tree");
    },
  });
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.deepEqual(calls, [{
    executable: "taskkill.exe",
    args: ["/PID", "43210", "/T", "/F"],
    options: { shell: false, windowsHide: true, stdio: "ignore" },
  }]);
  termination.cancel();
});

test("natural child exit cancels the pending Windows tree kill", async () => {
  const calls = [];
  const termination = terminateProcessTree(54321, {
    platform: "win32",
    graceMs: 20,
    spawnHelper(executable, args) {
      calls.push({ executable, args });
      return {};
    },
  });
  termination.cancel();
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.deepEqual(calls, []);
});
