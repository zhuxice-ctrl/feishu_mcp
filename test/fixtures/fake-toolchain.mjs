/**
 * Test fixture: create fake toolchain executables under a temporary root.
 *
 * Tests never depend on a real Windows signature or a real SDK install. Each
 * fake executable is an ordinary file whose content/mtime the test controls,
 * so cache invalidation and file-identity changes are deterministic.
 */

import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";

export async function createFakeExecutable(root, rel, { content = "fake-bin", version } = {}) {
  const file = path.join(root, rel);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, content);
  if (version) {
    await fs.writeFile(`${file}.version`, version);
  }
  return file;
}

/**
 * Replace a fixture's contents and bump its mtime so the resolver's
 * file-identity changes on the next resolution (cache invalidation).
 */
export async function replaceFixture(file, { content = "fake-bin-replaced-contents" } = {}) {
  await fs.writeFile(file, content);
  const future = new Date(Date.now() + 5000);
  await fs.utimes(file, future, future);
}

export async function makeSymlink(linkPath, target) {
  await fs.mkdir(path.dirname(linkPath), { recursive: true });
  await fs.symlink(target, linkPath);
}

export function statMtimeMs(file) {
  return fsSync.statSync(file).mtimeMs;
}
