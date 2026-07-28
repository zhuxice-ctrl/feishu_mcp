import assert from "node:assert/strict";
import test from "node:test";

process.env.AUTH_MODE = "none";
const { classifyCommand } = await import("../dist/tools/commandPolicy.js");

for (const command of [
  "dir",
  "dir /b",
  "whoami",
  "hostname",
  "cd",
  "pwd",
]) {
  test(`classifies read-only command: ${command}`, () => {
    assert.equal(classifyCommand(command).level, "read_only");
  });
}

for (const command of [
  "dir | more",
  "type README.md > copy.txt",
  "dir && del file.txt",
  "echo $(whoami)",
  "echo %COMSPEC%",
  "powershell -Command Get-ChildItem",
  "cmd /c dir",
  "node script.js",
  "python script.py",
  "npm test",
  "git commit -am change",
  "git -c core.pager=evil status",
  "git diff --ext-diff",
  "rg --pre converter pattern",
  "custom-tool --read-only",
  "type README.md",
  "type ..\\outside.txt",
  "dir C:\\",
  "git status",
  "git log -5",
  "git show HEAD",
  "git diff -- README.md",
  "rg pattern src",
  "findstr /s needle *.txt",
]) {
  test(`requires approval for command: ${command}`, () => {
    const risk = classifyCommand(command);
    assert.equal(risk.level, "approval_required");
    assert.ok(risk.reasons.length > 0);
  });
}
