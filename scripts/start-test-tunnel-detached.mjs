#!/usr/bin/env node
// start-test-tunnel-detached.mjs — 只分离式拉起测试隧道（不动服务）
// 用途：服务已在 3100 运行、仅需（重新）起隧道时，如隧道进程被外部杀掉后
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, openSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const TUNNEL_CONFIG = join(ROOT, 'config-test.yml');
const ENV_FILE = join(ROOT, '.env.test');

function die(msg) { console.error(`[start-test-tunnel-detached] FATAL: ${msg}`); process.exit(1); }
if (!existsSync(TUNNEL_CONFIG)) die('缺少 config-test.yml');
const cfg = readFileSync(TUNNEL_CONFIG, 'utf8');
const m = cfg.match(/^tunnel:\s*([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\s*$/m);
if (!m) die('config-test.yml 里没有合法的 tunnel UUID');

let logDir = join(ROOT, 'logs');
try {
  for (const line of readFileSync(ENV_FILE, 'utf8').split(/\r?\n/)) {
    const t = line.trim();
    const eq = t.indexOf('=');
    if (eq > 0 && t.slice(0, eq).trim() === 'LOG_DIR') { logDir = t.slice(eq + 1).trim(); break; }
  }
} catch { /* .env.test 缺失时用默认 */ }
mkdirSync(logDir, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const out = openSync(join(logDir, `test-tunnel-${stamp}.log`), 'a');
const child = spawn('cloudflared', ['tunnel', '--config', TUNNEL_CONFIG, 'run', m[1]], {
  cwd: ROOT, detached: true, stdio: ['ignore', out, out],
});
child.unref();
console.log(`detached tunnel pid=${child.pid} uuid=${m[1]} log=${join(logDir, `test-tunnel-${stamp}.log`)}`);
