import assert from "node:assert/strict";
import test from "node:test";

process.env.AUTH_MODE = "none";
const { compileGlob, normalizeGlobPath } = await import("../dist/tools/globPattern.js");

test("normalizes Windows separators", () => {
  assert.equal(normalizeGlobPath(".\\src\\file.ts"), "src/file.ts");
});

for (const [pattern, match, miss] of [
  ["*.ts", "src/file.ts", "src/file.js"],
  ["src/**/*.ts", "src/deep/file.ts", "test/file.ts"],
  ["**/*.{ts,tsx}", "src/view.tsx", "src/view.js"],
  ["file[0-9].txt", "nested/file4.txt", "nested/filex.txt"],
  ["src/?.ts", "src/a.ts", "src/long.ts"],
]) {
  test(`matches glob ${pattern}`, () => {
    const matcher = compileGlob(pattern);
    assert.equal(matcher(match, match.split("/").at(-1)), true);
    assert.equal(matcher(miss, miss.split("/").at(-1)), false);
  });
}

test("rejects an empty glob", () => {
  assert.throws(() => compileGlob(""), /cannot be empty/);
});
