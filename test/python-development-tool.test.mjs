import assert from "node:assert/strict";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const workspace = await mkdtemp(path.join(os.tmpdir(), "feishu-python-development-"));
const outsideWorkspace = await mkdtemp(path.join(os.tmpdir(), "feishu-python-development-outside-"));
const approvalRoot = await mkdtemp(path.join(os.tmpdir(), "feishu-python-development-approval-"));
process.env.AUTH_MODE = "none";
process.env.ALLOWED_DIRS = workspace;
process.env.APPROVAL_DATA_DIR = approvalRoot;
process.env.APPROVAL_STATE_SECRET = "00112233445566778899aabbccddeeff";
process.env.LOG_LEVEL = "error";

const {
  pythonDevelopmentInputSchema,
  buildPythonInvocation,
  buildPytestArgs,
  pythonDevelopment,
  resolvePythonInterpreter,
  validateRelativeTarget,
} = await import("../dist/tools/pythonDevelopment.js");

function context(modern = true, signal = new AbortController().signal) {
  return {
    mcpReq: {
      envelope: modern ? {} : undefined,
      requestState: () => undefined,
      inputResponses: undefined,
      signal,
    },
  };
}

function parse(result) {
  return JSON.parse(result.content[0].text);
}

test.after(async () => {
  await rm(workspace, { recursive: true, force: true });
  await rm(outsideWorkspace, { recursive: true, force: true });
  await rm(approvalRoot, { recursive: true, force: true });
});

test("schema rejects unknown fields and requires exactly one script_run mode", () => {
  assert.throws(() => pythonDevelopmentInputSchema.parse({
    action: "python_version",
    workdir: workspace,
    extra: true,
  }));
  assert.throws(() => pythonDevelopmentInputSchema.parse({
    action: "script_run",
    workdir: workspace,
    script: "main.py",
    module: "pkg.main",
  }));
  assert.throws(() => pythonDevelopmentInputSchema.parse({
    action: "script_run",
    workdir: workspace,
  }));
  assert.throws(() => pythonDevelopmentInputSchema.parse({
    action: "pytest_run",
    workdir: workspace,
    pytestArgs: { targets: ["tests/unit"], raw: ["--maxfail=1"] },
  }));
});

test("resolvePythonInterpreter prefers the Windows venv layout before launcher fallback", async () => {
  const venvScripts = path.join(workspace, ".venv", "Scripts");
  const venvBin = path.join(workspace, ".venv", "bin");
  await mkdir(venvScripts, { recursive: true });
  await mkdir(venvBin, { recursive: true });
  await writeFile(path.join(venvBin, "python"), "bin");
  await writeFile(path.join(venvScripts, "python.exe"), "scripts");
  assert.equal(resolvePythonInterpreter(workspace), path.join(venvScripts, "python.exe"));
});

test("resolvePythonInterpreter falls back to the launcher when no venv exists", async () => {
  const plain = await mkdtemp(path.join(os.tmpdir(), "feishu-python-development-plain-"));
  assert.equal(
    resolvePythonInterpreter(plain),
    process.platform === "win32" ? "py" : "python3",
  );
  return rm(plain, { recursive: true, force: true });
});

test("resolvePythonInterpreter accepts an explicit contained path or launcher", () => {
  const launcher = resolvePythonInterpreter(workspace, "py");
  assert.equal(launcher, "py");
  const nested = path.join(workspace, "tools", "python.exe");
  assert.equal(resolvePythonInterpreter(workspace, "tools/python.exe"), nested);
});

test("validateRelativeTarget blocks traversal and pytest-style flags", () => {
  assert.throws(() => validateRelativeTarget(workspace, "../escape.py"));
  assert.throws(() => validateRelativeTarget(workspace, "-q"));
  assert.equal(validateRelativeTarget(workspace, "pkg/run.py"), path.join(workspace, "pkg", "run.py"));
});

test("buildPytestArgs maps quiet, ignore, and targets into direct argv values", () => {
  const args = buildPytestArgs({
    quiet: true,
    ignore: ["tests/skip"],
    targets: ["tests/unit", "tests/integration"],
  }, workspace);
  assert.deepEqual(args, [
    "-q",
    "--ignore", path.join(workspace, "tests", "skip"),
    path.join(workspace, "tests", "unit"),
    path.join(workspace, "tests", "integration"),
  ]);
});

test("buildPythonInvocation produces a direct executable and argv vector", () => {
  const invocation = buildPythonInvocation({
    action: "script_run",
    workdir: workspace,
    python: "py",
    script: "scripts/run.py",
  });
  assert.deepEqual(invocation, {
    executable: "py",
    args: [path.join(workspace, "scripts", "run.py")],
  });
  assert.deepEqual(buildPythonInvocation({
    action: "pytest_run",
    workdir: workspace,
    pytestArgs: { quiet: true, targets: ["tests/unit"] },
  }), {
    executable: resolvePythonInterpreter(workspace),
    args: ["-m", "pytest", "-q", path.join(workspace, "tests", "unit")],
  });
});

function makeDeps(captured = []) {
  return {
    captured,
    deps: {
      userId: () => "owner",
      requestApproval: async () => true,
      runProcess: async (executable, args, options) => {
        captured.push({ executable, args, options });
        return {
          stdout: "done",
          stderr: "",
          exitCode: 0,
          killed: false,
          timedOut: false,
          truncated: false,
          durationMs: 1,
        };
      },
    },
  };
}

test("pythonDevelopment requires a workdir", async () => {
  const { deps } = makeDeps();
  const result = await pythonDevelopment({ action: "python_version" }, context(), deps);
  assert.equal(parse(result).code, "INVALID_ARGUMENT");
});

test("pythonDevelopment rejects non-owner callers", async () => {
  const { deps } = makeDeps();
  const denied = await pythonDevelopment(
    { action: "python_version", workdir: workspace },
    context(),
    { ...deps, userId: () => null },
  );
  assert.equal(parse(denied).code, "AUTHENTICATION_REQUIRED");
});

test("pythonDevelopment rejects a workdir outside allowed roots before execution", async () => {
  const { deps } = makeDeps();
  const denied = await pythonDevelopment(
    { action: "python_version", workdir: outsideWorkspace },
    context(),
    deps,
  );
  assert.equal(denied.isError, true);
  assert.match(parse(denied).code, /^DIRECTORY_|OUTSIDE_ALLOWED_DIRS/);
});

test("pythonDevelopment forwards timeout, cancellation, and output limit to the runner", async () => {
  const captured = [];
  const { deps } = makeDeps(captured);
  const controller = new AbortController();
  const result = await pythonDevelopment(
    {
      action: "python_version",
      workdir: workspace,
      timeout: Number.MAX_SAFE_INTEGER,
      python: "py",
    },
    context(true, controller.signal),
    {
      ...deps,
      maxOutputBytes: 4096,
    },
  );
  const body = parse(result);
  assert.equal(body.ok, true);
  assert.equal(captured.length, 1);
  assert.equal(captured[0].executable, "py");
  assert.deepEqual(captured[0].args, ["--version"]);
  assert.equal(captured[0].options.signal, controller.signal);
  assert.equal(captured[0].options.maxOutputBytes, 4096);
  assert.ok(captured[0].options.timeoutMs < Number.MAX_SAFE_INTEGER);
});

test("pythonDevelopment uses a no-shell argv vector for scripts and pytest", async () => {
  const captured = [];
  const { deps } = makeDeps(captured);
  await pythonDevelopment(
    {
      action: "script_run",
      workdir: workspace,
      python: "py",
      script: "scripts/run.py",
    },
    context(),
    deps,
  );
  await pythonDevelopment(
    {
      action: "pytest_run",
      workdir: workspace,
      python: "py",
      pytestArgs: {
        quiet: true,
        ignore: ["tests/skip"],
        targets: ["tests/unit"],
      },
    },
    context(),
    deps,
  );
  assert.equal(captured[0].executable, "py");
  assert.deepEqual(captured[0].args, [path.join(workspace, "scripts", "run.py")]);
  assert.deepEqual(captured[1].args, [
    "-m", "pytest",
    "-q",
    "--ignore", path.join(workspace, "tests", "skip"),
    path.join(workspace, "tests", "unit"),
  ]);
});
