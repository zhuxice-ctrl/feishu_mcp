#!/usr/bin/env node
// restart-orchestrator.mjs — restart_service 工具的内部执行器（非用户入口）
// 流程: 等 MCP 响应冲刷 → 终止旧进程 → 等其退出与端口释放 → 分离式拉起
//       start-test-mcp.mjs（仅服务）→ 退出
// 隧道（cloudflared）是独立进程：不碰它，它会自己重连新 origin。
// 拉起走隔离启动器，隔离不变量（干净 env / ALLOWED_DIRS / 固定 3100）与首启完全一致。

import { execSync, spawn } from 'node:child_process';
import { mkdirSync, openSync, writeSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { connect as tcpConnect } from 'node:net';

const ROOT = resolve(import.meta.dirname, '..');
const argv = process.argv.slice(2);
const pidIdx = argv.indexOf('--pid');
const portIdx = argv.indexOf('--port');
const reasonIdx = argv.indexOf('--reason');
const REASON = reasonIdx >= 0 ? argv.slice(reasonIdx + 1).join(' ') : 'unspecified';
const TEST_PORT = 3100;

function fatal(msg) { console.error(`[restart-orchestrator] FATAL: ${msg}`); process.exit(2); }

// 无 --pid 时按端口自解析：解析旧实例只能由编排器做，避免外部手工传错
function resolvePidFromPort(port) {
  try {
    const out = execSync(`netstat -ano | findstr :${port} | findstr LISTENING`, { encoding: 'utf8', timeout: 8000 });
    for (const line of out.split(/\r?\n/)) {
      const parts = line.trim().split(/\s+/);
      const pid = Number(parts[parts.length - 1]);
      if (Number.isInteger(pid) && pid > 0) return pid;
    }
  } catch { /* 无 LISTENING 匹配 */ }
  return NaN;
}

let OLD_PID = pidIdx >= 0 ? Number(argv[pidIdx + 1]) : NaN;
if (!Number.isInteger(OLD_PID) || OLD_PID <= 0) {
  const scanPort = portIdx >= 0 ? Number(argv[portIdx + 1]) : NaN;
  if (!Number.isInteger(scanPort) || scanPort <= 0) fatal('--pid 或 --port 必填');
  OLD_PID = resolvePidFromPort(scanPort);
  if (!Number.isInteger(OLD_PID) || OLD_PID <= 0) fatal(`端口 ${scanPort} 上没有 LISTENING 进程`);
}

const logDir = process.env['LOG_DIR'] || join(ROOT, 'logs');
mkdirSync(logDir, { recursive: true });
let logFd = null;
try { logFd = openSync(join(logDir, 'restart-orchestrator.log'), 'a'); } catch { /* 退回 stderr */ }
const say = (msg) => {
  const line = `[${new Date().toISOString()}] ${msg}\n`;
  if (logFd !== null) { try { writeSync(logFd, line); } catch { /* ignore */ } }
  process.stderr.write(line);
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function processAlive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (e) { return e && e.code === 'EPERM'; } // 存在但无权限 → 视为存活
}

function isPortOpen(port, host = '127.0.0.1') {
  return new Promise((yes) => {
    const s = tcpConnect({ port, host, timeout: 800 });
    s.once('connect', () => { s.destroy(); yes(true); });
    s.once('error', () => { s.destroy(); yes(false); });
    s.once('timeout', () => { s.destroy(); yes(false); });
  });
}

async function main() {
  say(`start: oldPid=${OLD_PID} reason="${REASON}"`);

  // 1) 等调用方 MCP 响应冲刷（restart_service 已返回结果，约 2s 余量）
  await sleep(2000);

  // 2) 终止旧进程（Windows 上 process.kill 即强制终止）
  if (processAlive(OLD_PID)) {
    try { process.kill(OLD_PID); say(`已向 ${OLD_PID} 发送终止`); }
    catch (e) { say(`kill 失败（可能已退出）: ${e && e.code ? e.code : e}`); }
  } else {
    say(`旧进程 ${OLD_PID} 已不存在，跳过 kill`);
  }

  // 3) 等退出（最长 15s）
  for (let i = 0; i < 30 && processAlive(OLD_PID); i++) await sleep(500);
  if (processAlive(OLD_PID)) fatal(`旧进程 ${OLD_PID} 15s 后仍存活，放弃重启`);
  say('旧进程已退出');

  // 4) 等端口释放（最长 10s）
  for (let i = 0; i < 20 && (await isPortOpen(TEST_PORT)); i++) await sleep(500);
  if (await isPortOpen(TEST_PORT)) fatal(`端口 ${TEST_PORT} 仍被占用，放弃重启`);
  say(`端口 ${TEST_PORT} 已释放`);

  // 5) 分离式拉起隔离启动器（仅服务；隧道不受影响、自动重连）
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const relaunchLog = openSync(join(logDir, `restart-relaunch-${stamp}.log`), 'a');
  const child = spawn(process.execPath, [join('scripts', 'start-test-mcp.mjs')], {
    cwd: ROOT,
    detached: true,
    stdio: ['ignore', relaunchLog, relaunchLog],
    env: process.env,
  });
  child.unref();
  say(`已拉起: start-test-mcp.mjs pid=${child.pid} log=restart-relaunch-${stamp}.log`);
  say('done');
  process.exit(0);
}

main().catch((e) => fatal((e && e.stack) || String(e)));
