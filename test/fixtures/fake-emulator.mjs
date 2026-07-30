/**
 * Fake emulator/avdmanager fixture for Android adapter tests.
 *
 * Records the planned commands the adapter emits (AVD list, create, start,
 * stop, boot probes) and returns canned output, so unit tests can exercise
 * the emulator lifecycle without a real AVD or emulator process.
 */

const responses = new Map();

export function setResponse(key, value) {
  responses.set(key, value);
}

export function defaultResponses() {
  return {
    "list avd":
      "Available Android Virtual Devices:\n    Name: test_avd\n    Path: /avd/test_avd.avd\n",
    create: "",
    start: "",
    stop: "",
    "sys.boot_completed": "1",
    "dev.bootcomplete": "1",
  };
}

export function runFakeEmulator(plan) {
  const joined = plan.args.join(" ");
  if (joined.includes("list avd")) return responses.get("list avd") ?? "";
  if (joined.includes("create") && joined.includes("avd")) return responses.get("create") ?? "";
  if (joined.includes("-avd")) return responses.get("start") ?? "";
  if (joined.includes("emu") && joined.includes("kill")) return responses.get("stop") ?? "";
  if (joined.includes("sys.boot_completed")) return responses.get("sys.boot_completed") ?? "1";
  if (joined.includes("dev.bootcomplete")) return responses.get("dev.bootcomplete") ?? "1";
  return "";
}

Object.assign(responses, defaultResponses());
