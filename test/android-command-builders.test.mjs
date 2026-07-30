import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildAdbCommand,
  buildGradleCommand,
  buildEmulatorCommand,
  buildAvdmanagerCommand,
  buildApksignerCommand,
} from "../dist/development/android/commands.js";
import {
  resolveAndroidToolchain,
  ANDROID_TOOLCHAIN_COMPONENTS,
} from "../dist/development/android/toolchain.js";

/** Build a fully-ready toolchain snapshot fixture. */
function readySnapshot(overrides = {}) {
  const base = {
    version: 1,
    catalogDigest: "deadbeef",
    digest: "cafebabe",
    createdAt: "2026-07-30T00:00:00.000Z",
    components: [
      snap("microsoft.openjdk.17", "ready", "C:\\jdk17\\bin\\java.exe", "17.0.11"),
      snap("org.gradle.distribution", "ready", "C:\\gradle\\bin\\gradle.bat", "8.9"),
      snap("google.android.commandlinetools", "ready", "C:\\sdk\\cmdline\\bin\\sdkmanager.bat", "11.0"),
      snap("google.android.platform-tools", "ready", "C:\\sdk\\platform-tools\\adb.exe", "35.0.2"),
      snap("google.android.emulator", "ready", "C:\\sdk\\emulator\\emulator.exe", "35.1.0"),
      snap("google.android.build-tools.35", "ready", "C:\\sdk\\build-tools\\35\\apksigner.bat", "35.0.0"),
    ],
  };
  return { ...base, ...overrides };
}

function snap(componentId, state, realPath, version) {
  return {
    componentId,
    target: "android",
    state,
    realPath,
    fileIdentity: `id:${componentId}`,
    version,
  };
}

const toolchain = resolveAndroidToolchain(readySnapshot());
assert.ok(toolchain.toolchain, "fixture toolchain should resolve");

test("adb start_app builds explicit am start invocation", () => {
  assert.deepEqual(
    buildAdbCommand(toolchain.toolchain, {
      action: "start_app",
      serial: "emulator-5554",
      packageId: "com.example.app",
      activity: ".MainActivity",
    }),
    {
      executable: "C:\\sdk\\platform-tools\\adb.exe",
      args: ["-s", "emulator-5554", "shell", "am", "start", "-n", "com.example.app/.MainActivity"],
    },
  );
});

test("adb force_stop builds explicit am force-stop invocation", () => {
  assert.deepEqual(
    buildAdbCommand(toolchain.toolchain, {
      action: "force_stop",
      serial: "emulator-5554",
      packageId: "com.example.app",
    }),
    {
      executable: "C:\\sdk\\platform-tools\\adb.exe",
      args: ["-s", "emulator-5554", "shell", "am", "force-stop", "com.example.app"],
    },
  );
});

test("adb clear builds pm clear", () => {
  assert.deepEqual(
    buildAdbCommand(toolchain.toolchain, {
      action: "clear",
      serial: "emulator-5554",
      packageId: "com.example.app",
    }),
    {
      executable: "C:\\sdk\\platform-tools\\adb.exe",
      args: ["-s", "emulator-5554", "shell", "pm", "clear", "com.example.app"],
    },
  );
});

test("adb install builds fixed install flags", () => {
  assert.deepEqual(
    buildAdbCommand(toolchain.toolchain, {
      action: "install",
      serial: "emulator-5554",
      hostApk: "C:\\build\\app-debug.apk",
    }),
    {
      executable: "C:\\sdk\\platform-tools\\adb.exe",
      args: ["-s", "emulator-5554", "install", "-r", "C:\\build\\app-debug.apk"],
    },
  );
});

test("adb uninstall builds pm uninstall", () => {
  assert.deepEqual(
    buildAdbCommand(toolchain.toolchain, {
      action: "uninstall",
      serial: "emulator-5554",
      packageId: "com.example.app",
    }),
    {
      executable: "C:\\sdk\\platform-tools\\adb.exe",
      args: ["-s", "emulator-5554", "shell", "pm", "uninstall", "com.example.app"],
    },
  );
});

test("adb devices lists attached devices", () => {
  assert.deepEqual(
    buildAdbCommand(toolchain.toolchain, { action: "devices" }),
    {
      executable: "C:\\sdk\\platform-tools\\adb.exe",
      args: ["devices", "-l"],
    },
  );
});

test("adb screencap exec-out screenshot", () => {
  assert.deepEqual(
    buildAdbCommand(toolchain.toolchain, {
      action: "screenshot",
      serial: "emulator-5554",
      hostPng: "C:\\shots\\screen.png",
    }),
    {
      executable: "C:\\sdk\\platform-tools\\adb.exe",
      args: ["-s", "emulator-5554", "exec-out", "screencap", "-p"],
    },
  );
  // hostPng is enforced by the tool layer, not the arg array; the screenshot
  // stream goes to stdout captured by the worker.
});

test("adb logcat fixed dump", () => {
  assert.deepEqual(
    buildAdbCommand(toolchain.toolchain, {
      action: "logcat",
      serial: "emulator-5554",
      pid: 1234,
    }),
    {
      executable: "C:\\sdk\\platform-tools\\adb.exe",
      args: ["-s", "emulator-5554", "logcat", "-d", "--pid=1234"],
    },
  );
});

test("adb push fixed transfer", () => {
  assert.deepEqual(
    buildAdbCommand(toolchain.toolchain, {
      action: "push",
      serial: "emulator-5554",
      hostFile: "C:\\x\\data.bin",
      deviceFile: "/sdcard/data.bin",
    }),
    {
      executable: "C:\\sdk\\platform-tools\\adb.exe",
      args: ["-s", "emulator-5554", "push", "C:\\x\\data.bin", "/sdcard/data.bin"],
    },
  );
});

test("adb pull fixed transfer", () => {
  assert.deepEqual(
    buildAdbCommand(toolchain.toolchain, {
      action: "pull",
      serial: "emulator-5554",
      deviceFile: "/sdcard/log.txt",
      hostFile: "C:\\x\\log.txt",
    }),
    {
      executable: "C:\\sdk\\platform-tools\\adb.exe",
      args: ["-s", "emulator-5554", "pull", "/sdcard/log.txt", "C:\\x\\log.txt"],
    },
  );
});

test("adb forward fixed forward", () => {
  assert.deepEqual(
    buildAdbCommand(toolchain.toolchain, {
      action: "forward",
      serial: "emulator-5554",
      localPort: 8080,
      remoteSpec: "tcp:8080",
    }),
    {
      executable: "C:\\sdk\\platform-tools\\adb.exe",
      args: ["-s", "emulator-5554", "forward", "tcp:8080", "tcp:8080"],
    },
  );
});

test("adb diagnostic dumpsys_package enum maps to fixed tokens", () => {
  assert.deepEqual(
    buildAdbCommand(toolchain.toolchain, {
      action: "diagnostic",
      diagnostic: "dumpsys_package",
      serial: "emulator-5554",
      packageId: "com.example.app",
    }),
    {
      executable: "C:\\sdk\\platform-tools\\adb.exe",
      args: ["-s", "emulator-5554", "shell", "dumpsys", "package", "com.example.app"],
    },
  );
});

test("gradle build maps to fixed assembleDebug task", () => {
  assert.deepEqual(
    buildGradleCommand(toolchain.toolchain, {
      action: "build",
      module: "app",
      variant: "debug",
      projectDir: "C:\\proj\\App",
    }),
    {
      executable: "C:\\gradle\\bin\\gradle.bat",
      args: [
        "--no-daemon",
        "--console=plain",
        "--stacktrace",
        "-p",
        "C:\\proj\\App",
        ":app:assembleDebug",
      ],
    },
  );
});

test("gradle bundle maps to bundleRelease", () => {
  assert.deepEqual(
    buildGradleCommand(toolchain.toolchain, {
      action: "bundle",
      module: "app",
      variant: "release",
      projectDir: "C:\\proj\\App",
    }),
    {
      executable: "C:\\gradle\\bin\\gradle.bat",
      args: [
        "--no-daemon",
        "--console=plain",
        "--stacktrace",
        "-p",
        "C:\\proj\\App",
        ":app:bundleRelease",
      ],
    },
  );
});

test("gradle unit test maps to testDebugUnitTest", () => {
  assert.deepEqual(
    buildGradleCommand(toolchain.toolchain, {
      action: "test_unit",
      module: "app",
      variant: "debug",
      projectDir: "C:\\proj\\App",
    }),
    {
      executable: "C:\\gradle\\bin\\gradle.bat",
      args: [
        "--no-daemon",
        "--console=plain",
        "--stacktrace",
        "-p",
        "C:\\proj\\App",
        ":app:testDebugUnitTest",
      ],
    },
  );
});

test("gradle caller cannot inject a task name", () => {
  assert.throws(
    () =>
      buildGradleCommand(toolchain.toolchain, {
        action: "build",
        module: "app; ./evil.sh",
        variant: "debug",
        projectDir: "C:\\proj\\App",
      }),
    /module/i,
  );
});

test("emulator start uses explicit serial and catalog avd", () => {
  const r = buildEmulatorCommand(toolchain.toolchain, {
    action: "start",
    avdName: "test_avd",
    port: 5554,
  });
  assert.equal(r.executable, "C:\\sdk\\emulator\\emulator.exe");
  assert.ok(r.args.includes("-avd"));
  assert.ok(r.args.includes("test_avd"));
  assert.ok(r.args.includes("-port"));
  assert.ok(r.args.includes("5554"));
  assert.ok(r.args.includes("-no-snapshot-save"));
  // no arbitrary flag passthrough
  assert.ok(!r.args.some((a) => a.includes("-shell") || a.includes("-qemu")));
});

test("emulator stop uses adb emu kill", () => {
  assert.deepEqual(
    buildEmulatorCommand(toolchain.toolchain, { action: "stop", serial: "emulator-5554" }),
    {
      executable: "C:\\sdk\\platform-tools\\adb.exe",
      args: ["-s", "emulator-5554", "emu", "kill"],
    },
  );
});

test("avdmanager list avd", () => {
  assert.deepEqual(
    buildAvdmanagerCommand(toolchain.toolchain, { action: "list" }),
    {
      executable: "C:\\sdk\\cmdline\\bin\\avdmanager.bat",
      args: ["list", "avd"],
    },
  );
});

test("avdmanager create avd sends no on stdin", () => {
  const r = buildAvdmanagerCommand(toolchain.toolchain, {
    action: "create",
    avdName: "test_avd",
    packageId: "system-images;android-35;google_apis;x86_64",
    device: "pixel_6",
  });
  assert.equal(r.executable, "C:\\sdk\\cmdline\\bin\\avdmanager.bat");
  assert.ok(r.args.includes("create"));
  assert.ok(r.args.includes("avd"));
  assert.equal(r.stdin, "no\n");
  assert.ok(r.args.includes("test_avd"));
  assert.ok(
    r.args.includes("system-images;android-35;google_apis;x86_64"),
  );
  assert.ok(r.args.includes("pixel_6"));
});

test("apksigner sign uses env: credential refs", () => {
  const r = buildApksignerCommand(toolchain.toolchain, {
    action: "sign",
    inApk: "C:\\build\\app-debug-unsigned.apk",
    outApk: "C:\\build\\app-debug.apk",
    keystore: "C:\\keys\\release.jks",
    ksAlias: "release",
    ksPassEnv: "FEISHU_MCP_KS_PASS",
    keyPassEnv: "FEISHU_MCP_KEY_PASS",
  });
  assert.equal(r.executable, "C:\\sdk\\build-tools\\35\\apksigner.bat");
  assert.ok(r.args.includes("sign"));
  assert.ok(r.args.includes("--ks"));
  assert.ok(r.args.includes("C:\\keys\\release.jks"));
  assert.ok(r.args.includes("--ks-pass"));
  assert.ok(r.args.includes("env:FEISHU_MCP_KS_PASS"));
  assert.ok(r.args.includes("--key-pass"));
  assert.ok(r.args.includes("env:FEISHU_MCP_KEY_PASS"));
  assert.ok(r.args.includes("C:\\build\\app-debug-unsigned.apk"));
  // no literal secret anywhere
  assert.ok(!r.args.some((a) => /password|secret/i.test(a)));
});

test("apksigner verify", () => {
  const r = buildApksignerCommand(toolchain.toolchain, {
    action: "verify",
    inApk: "C:\\build\\app-debug.apk",
  });
  assert.equal(r.executable, "C:\\sdk\\build-tools\\35\\apksigner.bat");
  assert.ok(r.args.includes("verify"));
  assert.ok(r.args.includes("--verbose"));
  assert.ok(r.args.includes("--print-certs"));
  assert.ok(r.args.includes("C:\\build\\app-debug.apk"));
});

test("unicode path preserved as single argv element", () => {
  const r = buildGradleCommand(toolchain.toolchain, {
    action: "build",
    module: "app",
    variant: "debug",
    projectDir: "C:\\用户\\项目\\App",
  });
  assert.ok(r.args.includes("C:\\用户\\项目\\App"));
});

test("whitespace in path preserved without shell splitting", () => {
  const r = buildAdbCommand(toolchain.toolchain, {
    action: "install",
    serial: "emulator-5554",
    hostApk: "C:\\build dir\\app debug.apk",
  });
  assert.ok(r.args.includes("C:\\build dir\\app debug.apk"));
  // the path is exactly one element, not split on whitespace
  assert.equal(r.args.filter((a) => a.includes("debug.apk")).length, 1);
});

test("malicious device serial rejected", () => {
  assert.throws(
    () =>
      buildAdbCommand(toolchain.toolchain, {
        action: "start_app",
        serial: "x & whoami",
        packageId: "com.example.app",
        activity: ".MainActivity",
      }),
    /serial/i,
  );
});

test("shell metacharacter in serial rejected", () => {
  for (const bad of ["emulator;5554", "emulator|cat", "emulator`id`", "emulator$HOME"]) {
    assert.throws(
      () =>
        buildAdbCommand(toolchain.toolchain, {
          action: "force_stop",
          serial: bad,
          packageId: "com.example.app",
        }),
      /serial/i,
    );
  }
});

test("malicious package id rejected", () => {
  assert.throws(
    () =>
      buildAdbCommand(toolchain.toolchain, {
        action: "force_stop",
        serial: "emulator-5554",
        packageId: "com.example; rm -rf /",
      }),
    /package/i,
  );
  assert.throws(
    () =>
      buildAdbCommand(toolchain.toolchain, {
        action: "force_stop",
        serial: "emulator-5554",
        packageId: "com.example.app && cat /etc/passwd",
      }),
    /package/i,
  );
});

test("extra unknown field rejected by strict schema", () => {
  assert.throws(() =>
    buildAdbCommand(toolchain.toolchain, {
      action: "start_app",
      serial: "emulator-5554",
      packageId: "com.example.app",
      activity: ".MainActivity",
      shell: "rm -rf /",
    }),
  );
});

test("second device without explicit serial rejected", () => {
  assert.throws(
    () =>
      buildAdbCommand(toolchain.toolchain, {
        action: "start_app",
        packageId: "com.example.app",
        activity: ".MainActivity",
      }),
    /serial/i,
  );
});

test("toolchain resolution: ENVIRONMENT_MISSING when component absent", () => {
  const snap = readySnapshot({
    components: readySnapshot().components.filter(
      (c) => c.componentId !== "google.android.platform-tools",
    ),
  });
  const r = resolveAndroidToolchain(snap);
  assert.ok(!("toolchain" in r));
  assert.equal(r.error, "ENVIRONMENT_MISSING");
  assert.ok(r.componentIds.includes("google.android.platform-tools"));
  // never expose a path
  assert.ok(JSON.stringify(r).indexOf("adb.exe") === -1);
});

test("toolchain resolution: TOOLCHAIN_UNTRUSTED when component untrusted", () => {
  const snapshot = readySnapshot({
    components: readySnapshot().components.map((c) =>
      c.componentId === "google.android.platform-tools"
        ? snap("google.android.platform-tools", "untrusted", undefined, undefined)
        : c,
    ),
  });
  const r = resolveAndroidToolchain(snapshot);
  assert.ok(!("toolchain" in r));
  assert.equal(r.error, "TOOLCHAIN_UNTRUSTED");
  assert.ok(r.componentIds.includes("google.android.platform-tools"));
});

test("toolchain resolution: missing realPath on ready component treated as missing", () => {
  const snapshot = readySnapshot({
    components: readySnapshot().components.map((c) =>
      c.componentId === "google.android.platform-tools"
        ? { ...c, realPath: undefined }
        : c,
    ),
  });
  const r = resolveAndroidToolchain(snapshot);
  assert.equal(r.error, "ENVIRONMENT_MISSING");
});

test("ANDROID_TOOLCHAIN_COMPONENTS lists exactly the required ids", () => {
  assert.deepEqual([...ANDROID_TOOLCHAIN_COMPONENTS].sort(), [
    "google.android.build-tools.35",
    "google.android.commandlinetools",
    "google.android.emulator",
    "google.android.platform-tools",
    "microsoft.openjdk.17",
    "org.gradle.distribution",
  ]);
});

test("builder never returns a shell string", () => {
  const cases = [
    buildAdbCommand(toolchain.toolchain, {
      action: "devices",
    }),
    buildGradleCommand(toolchain.toolchain, {
      action: "build",
      module: "app",
      variant: "debug",
      projectDir: "C:\\proj\\App",
    }),
  ];
  for (const c of cases) {
    assert.ok(Array.isArray(c.args), "args must be an array, never a shell string");
    assert.equal(typeof c.executable, "string");
  }
});
