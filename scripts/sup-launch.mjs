// sup-launch.mjs — 一次性拉起器：detached 启动 prod-supervisor.mjs 后立即退出
import { spawn } from 'node:child_process';
import { join, resolve } from 'node:path';
const ROOT = resolve(import.meta.dirname, '..');
const child = spawn(process.execPath, [join(ROOT, 'scripts', 'prod-supervisor.mjs')], {
  cwd: ROOT, detached: true, stdio: 'ignore', windowsHide: true
});
child.unref();
console.log('supervisor launched pid=' + child.pid);
