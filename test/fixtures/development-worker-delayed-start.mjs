// Coordinator bootstrap-liveness fixture.
//
// This process intentionally writes no heartbeat. It stays alive beyond the
// coordinator's configured startup grace, then commits a terminal task state.
// The coordinator must use its direct ChildProcess handle to avoid declaring
// a live-but-not-yet-initialized worker interrupted.

import path from "node:path";

const taskDir = process.env.FEISHU_MCP_TASK_DIR;
if (!taskDir) process.exit(2);

await new Promise((resolve) => setTimeout(resolve, 400));

const { DevelopmentTaskStore } = await import("../../dist/development/tasks/store.js");
const store = new DevelopmentTaskStore(path.dirname(taskDir));
const taskId = path.basename(taskDir);
store.update(taskId, "running", {
  state: "succeeded",
  endedAt: new Date().toISOString(),
  exit: { code: 0 },
});
