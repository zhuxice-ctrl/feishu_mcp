import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, readFile, mkdir, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { startMcpFixture, buildFakeToolchainCatalog } from "./helpers/mcp-http-fixture.mjs";

const NEW_TOOL_CALLS = [
  ["get_development_task", { taskId: "00000000-0000-4000-8000-000000000000" }],
  ["read_development_task_logs", { taskId: "00000000-0000-4000-8000-000000000000" }],
  ["cancel_development_task", { taskId: "00000000-0000-4000-8000-000000000000" }],
  ["inspect_development_environment", { targets: ["android"] }],
  ["plan_environment_changes", { targets: ["android"], components: ["google.android.platform-tools"], intent: "install" }],
  ["apply_environment_plan", { planId: "00000000-0000-4000-8000-000000000000" }],
  ["android_development", { action: "list_templates" }],
  ["windows_development", { action: "list_templates" }],
  ["manage_development_project", { action: "list_templates", ecosystem: "android" }],
];

const EXPECTED_TOOLS = [
  "ping", "read_file", "write_file", "edit_file", "create_directory",
  "list_directory", "move_file", "search_files", "get_file_info",
  "list_allowed_directories", "auth", "execute_command", "search_content",
  "git_status", "git_diff", "compare_files", "apply_patch", "web_fetch",
  "todo_write", "todo_read", "ask_user",
  "get_development_task", "read_development_task_logs", "cancel_development_task",
  "inspect_development_environment", "plan_environment_changes", "apply_environment_plan",
  "android_development",
  "windows_development",
  "manage_development_project",
];

function body(result) {
  return JSON.parse(result.content[0].text);
}

test("development tools E2E: 30-tool inventory and owner isolation", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "dev-e2e-"));
  const approvalDir = path.join(root, "approvals");
  const taskRoot = path.join(approvalDir, "tasks");
  const planDir = path.join(approvalDir, "plans");
  const catalogPath = path.join(root, "catalog.json");
  const ownerRoot = path.join(root, "owner");
  await mkdir(ownerRoot, { recursive: true });
  await mkdir(approvalDir, { recursive: true });
  await mkdir(taskRoot, { recursive: true });
  await mkdir(planDir, { recursive: true });
  await writeFile(catalogPath, buildFakeToolchainCatalog(), "utf8");

  const fixture = await startMcpFixture({
    ownerUserId: "owner",
    ownerDefaultDirs: ownerRoot,
    directoryApprovalFallback: "owner",
    approvalDataDir: approvalDir,
    taskRoot,
    catalogPath,
    planDir,
    allowedRoots: ownerRoot,
  });
  try {
    await fixture.rpc("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: { elicitation: { form: {} } },
      clientInfo: { name: "dev-e2e", version: "1.0.0" },
    });
    const listed = (await fixture.rpc("tools/list")).tools.map((t) => t.name);
    assert.deepEqual(listed, EXPECTED_TOOLS);
    assert.equal(listed.length, 30);

    // Non-owner callers are rejected with OWNER_REQUIRED for every new tool.
    for (const [name, args] of NEW_TOOL_CALLS) {
      const result = await fixture.callModern(name, args, "intruder");
      const b = body(result);
      assert.equal(b.ok, false, `${name} should fail for non-owner`);
      assert.equal(b.code, "OWNER_REQUIRED", `${name} non-owner code: ${b.code}`);
    }

    // Owner can list templates synchronously (read-only inspection).
    const tmpl = body(await fixture.callModern("manage_development_project", {
      action: "list_templates", ecosystem: "android",
    }));
    assert.equal(tmpl.ok, true, `${JSON.stringify(tmpl)}\n${fixture.output.join("")}`);

    // Health exposes aggregate data without secrets, paths, or task IDs.
    const health = await (await fetch(`${fixture.baseUrl}/health`)).json();
    assert.equal(health.toolCount, 30);
    const serialized = JSON.stringify(health);
    assert.doesNotMatch(serialized, /planId|environmentDigest|catalogDigest|brokerKey|ownerSid|pipePath|realPath|fileIdentity/i);
    assert.doesNotMatch(serialized, /taskId|ownerKey/i);
  } finally {
    await fixture.stop();
    await rm(root, { recursive: true, force: true });
  }
});

test("development tools E2E: project creation approval and retry chain", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "dev-e2e-approve-"));
  const approvalDir = path.join(root, "approvals");
  const ownerRoot = path.join(root, "owner");
  const dest = path.join(ownerRoot, "new-app");
  await mkdir(ownerRoot, { recursive: true });
  await mkdir(approvalDir, { recursive: true });

  const fixture = await startMcpFixture({
    ownerUserId: "owner",
    ownerDefaultDirs: ownerRoot,
    directoryApprovalFallback: "owner",
    approvalDataDir: approvalDir,
  });
  try {
    await fixture.rpc("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: { elicitation: { form: {} } },
      clientInfo: { name: "dev-e2e-approve", version: "1.0.0" },
    });
    const args = {
      action: "create", ecosystem: "android", templateId: "kotlin-basic",
      projectName: "TestApp", packageId: "com.test.app", destination: dest,
      profile: { compileSdk: 34, minSdk: 24, targetSdk: 34, agp: "8.2.0", kotlin: "1.9.20", gradle: "8.10.2" },
    };
    // First call elicits approval.
    const first = await fixture.callModern("manage_development_project", args);
    assert.equal(first.resultType, "input_required", `${JSON.stringify(first)}\n${fixture.output.join("")}`);
    // Retry with the accepted approval decision.
    const second = await fixture.retryModern(
      "manage_development_project", args, first,
      { approval: { action: "accept", content: { decision: "allow_once" } } },
    );
    const b = body(second);
    assert.equal(b.ok, true, JSON.stringify(b));
    assert.equal(b.ecosystem, "android");
    assert.ok(b.fileCount > 0);
    assert.ok(b.files.includes("gradlew"));
    assert.ok(b.files.includes("gradlew.bat"));
    assert.ok(b.files.includes("gradle/wrapper/gradle-wrapper.jar"));
    assert.ok(b.files.includes("gradle/wrapper/gradle-wrapper.properties"));

    const catalog = JSON.parse(await readFile(
      path.join(path.resolve(import.meta.dirname, ".."), "config", "development-package-catalog.json"),
      "utf8",
    ));
    const gradle = catalog.components.find((entry) => entry.id === "org.gradle.distribution");
    const properties = await readFile(
      path.join(dest, "gradle", "wrapper", "gradle-wrapper.properties"),
      "utf8",
    );
    assert.match(properties, /distributionUrl=https\\:\/\/services\.gradle\.org\/distributions\/gradle-8\.10\.2-bin\.zip/);
    assert.match(properties, new RegExp(`^distributionSha256Sum=${gradle.install.sha256}$`, "m"));
    assert.ok((await stat(path.join(dest, "gradle", "wrapper", "gradle-wrapper.jar"))).size > 0);
  } finally {
    await fixture.stop();
    await rm(root, { recursive: true, force: true });
  }
});
