/**
 * Test fixture for the development workflow worker.
 *
 * Simulates a serial PNPM verification workflow by executing a sequence of
 * short Node.js scripts. Each step prints a boundary marker and optional
 * output, and exits with a configurable code.
 *
 * Usage: node development-workflow-fixture.mjs --step <id> [--exit <code>] [--stdout <text>] [--stderr <text>]
 */

const args = process.argv.slice(2);
let stepId = "";
let exitCode = 0;
let stdoutText = "";
let stderrText = "";
let delay = 0;

for (let i = 0; i < args.length; i++) {
  if (args[i] === "--step" && i + 1 < args.length) stepId = args[++i];
  else if (args[i] === "--exit" && i + 1 < args.length) exitCode = parseInt(args[++i], 10);
  else if (args[i] === "--stdout" && i + 1 < args.length) stdoutText = args[++i];
  else if (args[i] === "--stderr" && i + 1 < args.length) stderrText = args[++i];
  else if (args[i] === "--delay" && i + 1 < args.length) delay = parseInt(args[++i], 10);
}

if (stdoutText) process.stdout.write(`${stdoutText}\n`);
if (stderrText) process.stderr.write(`${stderrText}\n`);

if (delay > 0) {
  setTimeout(() => process.exit(exitCode), delay);
} else {
  process.exit(exitCode);
}
