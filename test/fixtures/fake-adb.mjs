/**
 * Fake ADB server/worker fixture for Android adapter tests.
 *
 * Implements just enough of the ADB command surface the adapter emits
 * (devices, install/uninstall, am start/force-stop, pm clear, logcat,
 * screencap, push/pull, forward, diagnostics) so unit tests can exercise the
 * tool layer without a real device or emulator. Not used by pure command
 * builder / planning tests; intended for the HTTP e2e suite on a real machine.
 */

import { spawn } from "node:child_process";

const handlers = new Map();

export function registerHandler(action, fn) {
  handlers.set(action, fn);
}

export function defaultHandlers() {
  return {
    devices: () =>
      "List of devices attached\nemulator-5554          device product:emu64 model:Pixel_6 transport_id:1\n",
    install: () => "Success",
    uninstall: () => "Success",
    start_app: () => "Starting: Intent",
    force_stop: () => "",
    clear: () => "Success",
    logcat: () => "",
    screenshot: () => Buffer.from("PNG"),
    push: () => "",
    pull: () => "",
    forward: () => "",
    diagnostic: () => "",
  };
}

/**
 * Run the fake adb against a parsed plan. Returns stdout (string or Buffer).
 * Throws if the plan's action has no registered handler.
 */
export function runFake(plan) {
  const action = plan.args.includes("devices")
    ? "devices"
    : plan.args.includes("install")
      ? "install"
      : plan.args.includes("uninstall")
        ? "uninstall"
        : plan.args.includes("am", 2) && plan.args.includes("start")
          ? "start_app"
          : plan.args.includes("force-stop")
            ? "force_stop"
            : plan.args.includes("pm", 2) && plan.args.includes("clear")
              ? "clear"
              : plan.args.includes("logcat")
                ? "logcat"
                : plan.args.includes("screencap")
                  ? "screenshot"
                  : plan.args.includes("push")
                    ? "push"
                    : plan.args.includes("pull")
                      ? "pull"
                      : plan.args.includes("forward")
                        ? "forward"
                        : plan.args.includes("dumpsys") ||
                            plan.args.includes("getprop") ||
                            plan.args.includes("pidof") ||
                            plan.args.includes("df")
                          ? "diagnostic"
                          : "unknown";
  const h = handlers.get(action);
  if (!h) throw new Error(`fake-adb: no handler for action ${action}`);
  return h(plan);
}

Object.assign(handlers, defaultHandlers());
