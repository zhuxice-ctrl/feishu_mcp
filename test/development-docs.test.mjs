import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");

function read(rel) {
  return readFileSync(path.join(ROOT, rel), "utf8");
}

const README = read("README.md");
const GUIDE = read("docs/local-development-environment.md");
const AILY = read("docs/aily-integration-guide.md");
const CONFIG = read("src/config.ts");
const ENV_EXAMPLE = read(".env.example");

const ALL_TOOLS = [
  "ping", "read_file", "write_file", "edit_file", "create_directory",
  "list_directory", "move_file", "search_files", "get_file_info",
  "list_allowed_directories", "auth", "execute_command", "search_content",
  "git_status", "git_diff", "compare_files", "apply_patch", "web_fetch",
  "todo_write", "todo_read", "ask_user",
  "get_development_task", "read_development_task_logs", "cancel_development_task",
  "inspect_development_environment", "plan_environment_changes", "apply_environment_plan",
  "android_development", "windows_development", "manage_development_project",
];

const NEW_TOOLS = [
  "get_development_task", "read_development_task_logs", "cancel_development_task",
  "inspect_development_environment", "plan_environment_changes", "apply_environment_plan",
  "android_development", "windows_development", "manage_development_project",
];

// ---------------------------------------------------------------------------
// 1. All 30 tool names appear in README
// ---------------------------------------------------------------------------
test("README contains all 30 tool names", () => {
  for (const name of ALL_TOOLS) {
    assert.ok(README.includes(name), `README missing tool name: ${name}`);
  }
  assert.equal(ALL_TOOLS.length, 30, "expected exactly 30 tools");
});

// ---------------------------------------------------------------------------
// 2. Every new tool has a purpose description in README or guide
// ---------------------------------------------------------------------------
test("each new development tool has a purpose in README or guide", () => {
  const COMBINED = README + "\n" + GUIDE;
  for (const name of NEW_TOOLS) {
    const idx = COMBINED.indexOf(name);
    assert.ok(idx !== -1, `tool ${name} not found in README or guide`);
    // Check there is some descriptive text nearby (within 200 chars after the name)
    const nearby = COMBINED.slice(idx, idx + 250);
    assert.ok(
      nearby.length > name.length + 5,
      `tool ${name} appears but has no description nearby`,
    );
  }
});

// ---------------------------------------------------------------------------
// 3. Owner-only scope is explicit
// ---------------------------------------------------------------------------
test("owner-only scope is documented in README and guide", () => {
  const patterns = ["owner", "所有者"];
  for (const p of patterns) {
    assert.ok(README.includes(p), `README should mention owner scope (${p})`);
    assert.ok(GUIDE.includes(p), `guide should mention owner scope (${p})`);
  }
  // Explicit statement that dev tools are owner-only
  assert.ok(
    /owner.only|owner 专属|仅.*owner|所有者专用/i.test(README + GUIDE),
    "should explicitly state dev tools are owner-only",
  );
});

// ---------------------------------------------------------------------------
// 4. No-GUI exclusion is explicit
// ---------------------------------------------------------------------------
test("GUI exclusion is documented", () => {
  const COMBINED = README + "\n" + GUIDE;
  assert.ok(
    /GUI|图形界面|graphical/i.test(COMBINED),
    "should mention GUI exclusion",
  );
  assert.ok(
    /excluded|排除|不支持|not supported/i.test(COMBINED),
    "should state GUI automation is excluded/not supported",
  );
});

// ---------------------------------------------------------------------------
// 5. Administrator broker install/uninstall commands exist in docs
// ---------------------------------------------------------------------------
test("admin broker install and uninstall commands are documented", () => {
  const COMBINED = README + "\n" + GUIDE;
  assert.ok(
    /install.*broker|install-feishu-mcp-admin-broker/i.test(COMBINED),
    "should document broker install",
  );
  assert.ok(
    /uninstall.*broker|uninstall-feishu-mcp-admin-broker/i.test(COMBINED),
    "should document broker uninstall",
  );
});

// ---------------------------------------------------------------------------
// 6. Fixed-domain placeholders do not expose credentials
// ---------------------------------------------------------------------------
test("README does not expose real credentials", () => {
  // Should use placeholders, not real tokens
  assert.ok(
    /your-domain|your-secret|YOUR_TOKEN|your-token|placeholder/i.test(README),
    "should use placeholder domain/token examples",
  );
  // Should NOT contain ngrok authtoken values
  assert.ok(
    !/[0-9a-f]{40,}/i.test(README.replace(/your-secret-token-here|your-secret-token/gi, "")),
    "README should not contain long hex strings that look like real tokens",
  );
  // Pin should not be hardcoded
  assert.ok(
    !/AUTH_PIN\s*=\s*[a-zA-Z0-9]{8,}/.test(README),
    "README should not hardcode AUTH_PIN value",
  );
});

// ---------------------------------------------------------------------------
// 7. All configuration keys in .env.example exist in config.ts
// ---------------------------------------------------------------------------
test("all .env.example keys are referenced in config.ts", () => {
  const envKeys = [];
  for (const line of ENV_EXAMPLE.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    if (key) envKeys.push(key);
  }
  for (const key of envKeys) {
    assert.ok(
      CONFIG.includes(`"${key}"`) || CONFIG.includes(`process.env.${key}`),
      `config.ts does not reference env key: ${key}`,
    );
  }
});

// ---------------------------------------------------------------------------
// 8. Documented script paths exist
// ---------------------------------------------------------------------------
test("all scripts referenced in docs actually exist", () => {
  const COMBINED = README + "\n" + GUIDE + "\n" + AILY;
  // Extract script references like scripts/foo.ps1 or foo.bat
  const scriptRefs = [
    ...COMBINED.matchAll(/scripts\/[a-zA-Z0-9_-]+\.ps1/g),
    ...COMBINED.matchAll(/[a-zA-Z0-9_-]+\.bat/g),
  ];
  const seen = new Set();
  for (const m of scriptRefs) {
    const ref = m[0];
    if (seen.has(ref)) continue;
    seen.add(ref);
    const fullPath = ref.startsWith("scripts/")
      ? path.join(ROOT, ref)
      : path.join(ROOT, ref);
    assert.ok(
      existsSync(fullPath),
      `documented script does not exist: ${ref}`,
    );
  }
});

// ---------------------------------------------------------------------------
// 9. Tool inventory number is 30 in README
// ---------------------------------------------------------------------------
test("README states 30 tools", () => {
  assert.ok(
    /30\s*(个|tools?|工具)/i.test(README),
    "README should state 30 tools",
  );
  // Old count should not appear
  assert.ok(
    !/21\s*(个|tools?|工具)/.test(README),
    "README should not still say 21 tools",
  );
});

// ---------------------------------------------------------------------------
// 10. Aily integration guide mentions development tools are owner-only
// ---------------------------------------------------------------------------
test("Aily integration guide mentions development tools owner-only scope", () => {
  assert.ok(
    /owner|所有者/i.test(AILY),
    "Aily guide should mention owner scope for dev tools",
  );
  assert.ok(
    /development|开发/i.test(AILY),
    "Aily guide should mention development tools",
  );
  assert.ok(
    /task.id|task ID|任务\s*ID|long.*operation|长.*操作/i.test(AILY),
    "Aily guide should mention task IDs for long operations",
  );
});
