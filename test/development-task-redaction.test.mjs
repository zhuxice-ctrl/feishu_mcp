import assert from "node:assert/strict";
import test from "node:test";

process.env.AUTH_MODE = "none";
process.env.LOG_LEVEL = "error";

const { StreamingTaskRedactor } = await import("../dist/development/tasks/redaction.js");

test("configured secret values are redacted", () => {
  const redactor = new StreamingTaskRedactor(["hunter2"]);
  const out = redactor.push("password=hunter2 done\n") + redactor.flush();
  assert.doesNotMatch(out, /hunter2/);
  assert.match(out, /\[REDACTED\]/);
});

test("authorization bearer headers are redacted", () => {
  const redactor = new StreamingTaskRedactor([]);
  const out = redactor.push("Authorization: Bearer abc.def.ghi\n") + redactor.flush();
  assert.doesNotMatch(out, /abc\.def\.ghi/);
  assert.match(out, /\[REDACTED\]/);
});

test("password-like assignments are redacted", () => {
  const redactor = new StreamingTaskRedactor([]);
  const out = redactor.push("token=secretvalue storepass=mypass\n") + redactor.flush();
  assert.doesNotMatch(out, /secretvalue|mypass/);
  assert.match(out, /\[REDACTED\]/);
});

test("gradle signing properties are redacted", () => {
  const redactor = new StreamingTaskRedactor([]);
  const out =
    redactor.push("-Pandroid.inject.signing.store.password=s3cret keypass=zzz\n") +
    redactor.flush();
  assert.doesNotMatch(out, /s3cret/);
  assert.match(out, /\[REDACTED\]/);
});

test("a secret split across chunks is redacted", () => {
  const redactor = new StreamingTaskRedactor(["split-secret-value"]);
  const output =
    redactor.push("token=split-secret-") + redactor.push("value\n") + redactor.flush();
  assert.doesNotMatch(output, /split-secret-value/);
  assert.match(output, /\[REDACTED\]/);
});

test("flush after no input is empty", () => {
  const redactor = new StreamingTaskRedactor(["x"]);
  assert.equal(redactor.flush(), "");
});

test("redacted output never contains the raw fixture secret across many splits", () => {
  const secret = "abcdef0123456789";
  const redactor = new StreamingTaskRedactor([secret]);
  let output = "";
  for (const ch of `leading ${secret} trailing ${secret} end`) {
    output += redactor.push(ch);
  }
  output += redactor.flush();
  assert.doesNotMatch(output, /abcdef0123456789/);
});
