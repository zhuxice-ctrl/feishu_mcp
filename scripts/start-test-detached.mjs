import { spawn } from 'node:child_process';
import { openSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

// detached 启动包装: 让 start-test-mcp.mjs 脱离调用方进程生命周期存活
// （execute_command 会在 ~500ms 杀进程，直接跑会连坐启动器）
const ROOT = resolve(import.meta.dirname, '..');

function readLogDir() {
  try {
    for (const line of readFileSync(join(ROOT, '.env.test'), 'utf8').split(/\r?\n/)) {
      const m = line.match(/^\s*LOG_DIR\s*=\s*(.+?)\s*$/);
      if (m) return m[1];
    }
  } catch { /* fall through */ }
  return join(ROOT, 'logs');
}

const logDir = readLogDir();
if (!existsSync(logDir)) mkdirSync(logDir, { recursive: true });
const out = openSync(join(logDir, 'start-test-detached.log'), 'a');
const child = spawn(process.execPath, ['scripts/start-test-mcp.mjs', ...process.argv.slice(2)], {
  cwd: ROOT, detached: true, stdio: ['ignore', out, out],
});
child.unref();
console.log('detached launcher pid=' + child.pid + ' log=' + join(logDir, 'start-test-detached.log'));
