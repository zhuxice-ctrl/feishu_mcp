#!/usr/bin/env node
// prod-supervisor.mjs — feishu-mcp 生产实例守护（node + cloudflared 双进程看护）
// 职责：
//  1) 启动/接管：杀掉 :3000 上的孤儿进程，拉起 node dist/index.js（env=系统基础键+.env）
//  2) cloudflared 看护：生产隧道不在时拉起（按 UUID 匹配命令行，测试隧道在场不误判）；退出后自动重启
//  3) node 健康看门狗：本地 /health 连续 3 次失败 → 重启 node
//  4) 命令队列看门狗：每 180s 经 MCP 调 execute_command echo 探针；
//     QUEUE_TIMEOUT 或传输失败连续 2 次 → 重启 node（自愈 2026-09-09 两次队列死锁）
// 日志：logs/prod-supervisor.log；子进程 stdio → logs/prod-node.{out,err}.log / logs/prod-cloudflared.log

import { spawn, execSync } from 'node:child_process';
import { appendFileSync, readFileSync, openSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { connect as tcpConnect } from 'node:net';

const ROOT = resolve(import.meta.dirname, '..');
const LOG_DIR = join(ROOT, 'logs');
mkdirSync(LOG_DIR, { recursive: true });
const LOG = join(LOG_DIR, 'prod-supervisor.log');
const say = (m) => { const line = `[${new Date().toISOString()}] ${m}\n`; try { appendFileSync(LOG, line); } catch {} process.stdout.write(line); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// env：系统基础键 + .env（沿用 2026-09-09 queue-fix 验证过的逻辑）
const BASE_KEYS = ['PATH','Path','SYSTEMROOT','SystemRoot','TEMP','TMP','USERPROFILE','LOCALAPPDATA','APPDATA','PROGRAMDATA','PROGRAMFILES','PROGRAMFILES(X86)','COMMONPROGRAMFILES','COMMONPROGRAMFILES(X86)','COMPUTERNAME','USERNAME','ComSpec','PATHEXT','windir','NUMBER_OF_PROCESSORS','OS','PROCESSOR_ARCHITECTURE','HOMEDRIVE','HOMEPATH'];
function loadProdEnv() {
  const env = {};
  for (const k of BASE_KEYS) if (process.env[k] !== undefined) env[k] = process.env[k];
  try {
    const txt = readFileSync(join(ROOT, '.env'), 'utf8');
    for (let line of txt.split(/\r?\n/)) {
      line = line.trim();
      if (!line || line.startsWith('#')) continue;
      const i = line.indexOf('=');
      if (i < 0) continue;
      const k = line.slice(0, i).trim();
      let v = line.slice(i + 1).trim();
      const h = v.indexOf(' #');
      if (h >= 0) v = v.slice(0, h).trim();
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
      env[k] = v;
    }
  } catch (e) { say('WARN .env parse failed: ' + e.message); }
  delete env.FEISHU_MCP_MANAGED_LAUNCH;
  return env;
}

const PORT = 3000;
const TUNNEL_UUID = '6eb42d01-23ff-48a8-a992-82c16b2158cc';
const CF_CONFIG = 'C:/Users/Lenovo/.cloudflared/config.yml';
const BACKOFF = [1000, 2000, 5000, 10000, 30000, 60000];

const isPortOpen = (port) => new Promise((yes) => {
  const s = tcpConnect({ port, host: '127.0.0.1', timeout: 800 });
  s.once('connect', () => { s.destroy(); yes(true); });
  s.once('error', () => yes(false));
  s.once('timeout', () => { s.destroy(); yes(false); });
});

function pidsOnPort(port) {
  const pids = new Set();
  try {
    const out = execSync(`netstat -ano | findstr ":${port}" | findstr LISTENING`, { encoding: 'utf8', timeout: 10000 });
    for (const line of out.split('\n')) {
      const m = line.trim().match(/(\d+)\s*$/);
      if (m && Number(m[1]) !== process.pid) pids.add(m[1]);
    }
  } catch { /* 无匹配 */ }
  return [...pids];
}

function cloudflaredRunning() {
  // 按生产隧道 UUID 匹配命令行：避免测试隧道的 cloudflared.exe 在场时被误判为「生产隧道已存活」
  // （旧实现用 tasklist 任意匹配，测试隧道在场而生产隧道掉线时会跳过拉起 → 公网 502/530）
  try {
    const ps = `Get-CimInstance Win32_Process -Filter "Name='cloudflared.exe'" | Select-Object -ExpandProperty CommandLine`;
    const b64 = Buffer.from(ps, 'utf16le').toString('base64');
    const out = execSync(`powershell -NoProfile -EncodedCommand ${b64}`, { encoding: 'utf8', timeout: 15000 });
    return out.includes(TUNNEL_UUID);
  } catch { return false; }
}

// ---- node 子进程 ----
let nodeChild = null;
let restarting = false;
let backoffIdx = 0;
let shuttingDown = false;

function spawnNode(reason) {
  const env = loadProdEnv();
  const outFd = openSync(join(LOG_DIR, 'prod-node.out.log'), 'a');
  const errFd = openSync(join(LOG_DIR, 'prod-node.err.log'), 'a');
  const child = spawn(process.execPath, ['dist/index.js'], { cwd: ROOT, detached: false, stdio: ['ignore', outFd, errFd], env });
  nodeChild = child;
  say(`node spawned pid=${child.pid} (${reason})`);
  child.on('error', (e) => { say(`node spawn error: ${e.message}`); nodeChild = null; });
  child.on('exit', (code, sig) => {
    say(`node exited code=${code} sig=${sig}`);
    nodeChild = null;
    if (!shuttingDown) scheduleNodeRespawn('exit');
  });
}

function scheduleNodeRespawn(reason) {
  if (restarting) return;
  restarting = true;
  const wait = BACKOFF[Math.min(backoffIdx++, BACKOFF.length - 1)];
  say(`node respawn in ${wait}ms (${reason})`);
  setTimeout(() => { restarting = false; if (!shuttingDown) spawnNode(reason); }, wait);
}

async function restartNode(reason) {
  say(`restarting node (${reason})`);
  if (nodeChild) { try { process.kill(nodeChild.pid); } catch {} nodeChild = null; }
  for (let i = 0; i < 30 && (await isPortOpen(PORT)); i++) await sleep(500);
  if (await isPortOpen(PORT)) {
    for (const pid of pidsOnPort(PORT)) {
      say(`force-kill pid ${pid} on :${PORT}`);
      try { execSync(`taskkill /F /PID ${pid}`, { encoding: 'utf8', timeout: 10000 }); } catch {}
    }
    for (let i = 0; i < 20 && (await isPortOpen(PORT)); i++) await sleep(500);
  }
  backoffIdx = 0;
  spawnNode(reason);
}

// ---- cloudflared 子进程 ----
let cfChild = null;
function ensureCloudflared(reason) {
  if (cfChild && cfChild.exitCode === null) return;
  if (cloudflaredRunning()) { say(`cloudflared already running externally, skip spawn (${reason})`); cfChild = null; return; }
  const fd = openSync(join(LOG_DIR, 'prod-cloudflared.log'), 'a');
  const child = spawn('cloudflared', ['tunnel', '--config', CF_CONFIG, 'run', TUNNEL_UUID], { detached: false, stdio: ['ignore', fd, fd] });
  cfChild = child;
  say(`cloudflared spawned pid=${child.pid} (${reason})`);
  child.on('error', (e) => { say(`cloudflared spawn error: ${e.message}`); cfChild = null; });
  child.on('exit', (code) => {
    say(`cloudflared exited code=${code}`);
    cfChild = null;
    if (!shuttingDown) setTimeout(() => ensureCloudflared('exit-respawn'), 5000);
  });
}

// ---- 看门狗 ----
let healthFails = 0;
let queueFails = 0;

async function healthTick() {
  if (shuttingDown || restarting || !nodeChild) return;
  try {
    const r = await fetch(`http://127.0.0.1:${PORT}/health`, { signal: AbortSignal.timeout(5000) });
    if (r.ok) { healthFails = 0; return; }
    throw new Error('status ' + r.status);
  } catch (e) {
    healthFails++;
    say(`health fail ${healthFails}/3: ${e.message}`);
    if (healthFails >= 3) { healthFails = 0; await restartNode('health watchdog'); }
  }
}

function sseParse(text) {
  for (const line of text.split('\n')) if (line.startsWith('data:')) {
    try { return JSON.parse(line.slice(5).trim()); } catch { /* skip */ }
  }
  return null;
}

async function queueProbe() {
  if (shuttingDown || restarting || !nodeChild) return;
  const env = loadProdEnv();
  const headers = { 'content-type': 'application/json', 'accept': 'application/json, text/event-stream' };
  if (env.MCP_AUTH_TOKEN) headers['Authorization'] = 'Bearer ' + env.MCP_AUTH_TOKEN;
  const endpoint = `http://127.0.0.1:${PORT}${env.MCP_ENDPOINT || '/mcp'}`;
  const post = (body) => fetch(endpoint, { method: 'POST', headers, body: JSON.stringify(body), signal: AbortSignal.timeout(45000) }).then((r) => r.text());
  try {
    await post({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'supervisor', version: '1' } } });
    await post({ jsonrpc: '2.0', method: 'notifications/initialized' });
    const raw = await post({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'execute_command', arguments: { command: 'echo supervisor-probe', workdir: 'F:\\feishu_mcp' } } });
    const res = sseParse(raw);
    const text = (res && res.result && res.result.content && res.result.content[0] && res.result.content[0].text) || '';
    if (text.includes('QUEUE_TIMEOUT')) throw new Error('QUEUE_TIMEOUT');
    queueFails = 0;
  } catch (e) {
    queueFails++;
    say(`queue probe fail ${queueFails}/2: ${e.message}`);
    if (queueFails >= 2) { queueFails = 0; await restartNode('queue watchdog'); }
  }
}

async function main() {
  say('=== supervisor start (pid ' + process.pid + ') ===');
  // 接管：杀掉 :3000 上的孤儿进程
  const orphans = pidsOnPort(PORT);
  for (const pid of orphans) {
    say(`takeover: kill orphan pid ${pid} on :${PORT}`);
    try { execSync(`taskkill /F /PID ${pid}`, { encoding: 'utf8', timeout: 10000 }); } catch {}
  }
  if (orphans.length) for (let i = 0; i < 20 && (await isPortOpen(PORT)); i++) await sleep(500);
  spawnNode('startup');
  ensureCloudflared('startup');
  setInterval(healthTick, 20000);
  setInterval(queueProbe, 180000);
  setInterval(() => ensureCloudflared('periodic'), 60000);
}

function shutdown() {
  shuttingDown = true;
  say('shutdown requested');
  if (nodeChild) { try { process.kill(nodeChild.pid); } catch {} }
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

main().catch((e) => { say('FATAL ' + ((e && e.stack) || e)); process.exit(2); });
