/**
 * Fake package-manager fixture for Electron action tests.
 *
 * Records the executable + args it was invoked with so tests can assert
 * exact command lines. Does not actually install or run anything.
 */
import { writeFileSync } from "node:fs";
import path from "node:path";

export function createFakePackageManagerRecordFile(dir) {
  const recordFile = path.join(dir, ".pm-invocation.json");
  return recordFile;
}

/**
 * Write a minimal Electron project fixture into `dir`.
 * `manager` controls which lockfile is created.
 */
export function writeElectronFixture(dir, manager = "npm") {
  const pkg = {
    name: "test-electron-app",
    version: "1.0.0",
    main: "src/main.js",
    scripts: {
      start: "electron .",
      test: "node --test test/",
      package: "electron-builder --win",
    },
    devDependencies: {
      electron: "30.0.0",
      "electron-builder": "24.13.3",
    },
  };
  writeFileSync(path.join(dir, "package.json"), JSON.stringify(pkg, null, 2));

  if (manager === "npm") {
    writeFileSync(path.join(dir, "package-lock.json"), JSON.stringify({ lockfileVersion: 3 }));
  } else if (manager === "pnpm") {
    writeFileSync(path.join(dir, "pnpm-lock.yaml"), "lockfileVersion: '6.0'\n");
  } else if (manager === "yarn") {
    writeFileSync(path.join(dir, "yarn.lock"), "# yarn lockfile v1\n");
  }
}
