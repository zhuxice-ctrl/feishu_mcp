#!/usr/bin/env node
// start-test-mcp.mjs — feishu-mcp 测试实例隔离启动器（方案 B：独立隧道）
// 用法:
//   node scripts/start-test-mcp.mjs            启动本地测试服务（127.0.0.1:3100）
//   node scripts/start-test-mcp.mjs --tunnel   服务 + cloudflared 测试隧道（需 config-test.yml 已回填 UUID）
//   node scripts/start-test-mcp.mjs --check    只做预检，不启动
//
// 隔离规则（与 docs/dual-channel-plan-20260908.md 对齐）:
//   - 固定 PORT=3100；3000=生产 feishu-mcp、3001=godot-mcp，本启动器一律拒绝碰
//   - 强制 ALLOWED_DIRS=<项目根>（服务端 allow-list 硬边界，测试实例只看得到本子树）
//   - 启动前清除全部 owner/policy 环境变量，防止生产配置渗透
//   - 其余 env 全部来自 .env.test（独立 token、独立数据根）
//
// 隧道身份说明: cloudflared run 显式使用从 config-test.yml 解析出的隧道 UUID，
// 绝不按名字引用——实测按名字查询会误解析到生产隧道(6eb42d01)，UUID 是唯一可信标识。

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, openSync, readFileSync, writeSync, closeSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { connect as tcpConnect } from 'node:net';

const ROOT = resolve(import.meta.dirname, '..');
const ENV_FILE = join(ROOT, '.env.test');
const TEST_PORT = 3100;
const FORBIDDEN_PORTS = new Set([3000, 3001]); // 3000=feishu 生产，3001=godot-mcp
const FORBIDDEN_LABEL = { 3000: 'feishu-mcp 生产', 3001: 'godot-mcp' };
const TUNNEL_CONFIG = join(ROOT, 'config-test.yml');

// 生产/owner 类环境变量：测试实例一律清除，防渗透
const STRIP_ENV_KEYS = [
  'OWNER_USER_ID', 'GIT_COMMAND_POLICY', 'OWNER_COMMAND_POLICY',
  'OWNER_DEFAULT_DIRS', 'DIRECTORY_APPROVAL_FALLBACK',
  'APPROVAL_STATE_SECRET', 'DEV_ENV_OWNER_SID', 'DEV_ENV_BROKER_KEY_PATH',
];

const args = new Set(process.argv.slice(2));
const CHECK_ONLY = args.has('--check');
const WITH_TUNNEL = args.has('--tunnel');

function log(msg) { console.log(`[start-test-mcp] ${msg}`); }
function die(msg) { console.error(`[start-test-mcp] FATAL: ${msg}`); process.exit(1); }

function isPortOpen(port, host = '127.0.0.1') {
  return new Promise((yes) => {
    const s = tcpConnect({ port, host, timeout: 800 });
    s.once('connect', () => { s.destroy(); yes(true); });
    s.once('error', () => { s.destroy(); yes(false); });
    s.once('timeout', () => { s.destroy(); yes(false); });
  });
}

function parseEnvFile(file) {
  if (!existsSync(file)) die(`缺少 ${file}，测试环境未配置`);
  const kv = {};
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const eq = t.indexOf('=');
    if (eq <= 0) continue;
    kv[t.slice(0, eq).trim()] = t.slice(eq + 1).trim();
  }
  return kv;
}

function readTunnelUuid() {
  const cfg = readFileSync(TUNNEL_CONFIG, 'utf8');
  const m = cfg.match(/^tunnel:\s*([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\s*$/m);
  if (!m) die('config-test.yml 里没有合法的 tunnel UUID（或仍是 <TUNNEL_UUID> 占位符）');
  return m[1];
}

async function main() {
  if (FORBIDDEN_PORTS.has(TEST_PORT)) die(`TEST_PORT 不得使用 ${TEST_PORT}（${FORBIDDEN_LABEL[TEST_PORT]}）`);

  // 预检 1：3100 必须空闲
  if (await isPortOpen(TEST_PORT)) die(`端口 ${TEST_PORT} 已被占用，请先释放（netstat -ano | findstr :${TEST_PORT}）`);
  log(`预检通过: ${TEST_PORT} 空闲`);

  // 预检 2：生产 3000 状态仅报告，不接管、不管理
  const prodAlive = await isPortOpen(3000);
  log(`生产通道 3000: ${prodAlive ? '运行中（本启动器不管理它）' : '未运行'}`);

  // 预检 3：env 文件与关键值
  const kv = parseEnvFile(ENV_FILE);
  for (const key of ['MCP_AUTH_TOKEN', 'TEST_DATA_ROOT', 'APPROVAL_DATA_DIR']) {
    if (!kv[key]) die(`.env.test 缺少 ${key}`);
  }
  log(`env 就绪: 数据根=${kv['TEST_DATA_ROOT']}，token=<已配置，值不回显>`);

  // 预检 4：dist 存在
  if (!existsSync(join(ROOT, 'dist', 'index.js'))) die('dist/index.js 不存在，先 npm run build');
  log('dist/index.js 存在');

  const tunnelUuid = WITH_TUNNEL ? readTunnelUuid() : null;
  if (WITH_TUNNEL) log(`隧道身份: UUID=${tunnelUuid}（显式指定，不按名字引用）`);

  if (CHECK_ONLY) { log('预检全部通过（--check 模式，不启动）'); return; }

  // 组装干净 env：清生产渗透项 → 铺 .env.test → 强制覆盖隔离关键项
  const env = { ...process.env };
  for (const k of STRIP_ENV_KEYS) delete env[k];
  for (const [k, v] of Object.entries(kv)) env[k] = v;
  env['PORT'] = String(TEST_PORT);
  env['ALLOWED_DIRS'] = ROOT;
  env['HOST'] = '127.0.0.1';
  env['FEISHU_MCP_MANAGED_LAUNCH'] = '1'; // 重启标记：restart_service 工具只允许启动器托管的实例自重启

  // 日志目录
  const logDir = kv['LOG_DIR'] || join(ROOT, 'logs');
  mkdirSync(logDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const svcLog = openSync(join(logDir, `test-instance-${stamp}.log`), 'a');
  const emit = (tag, s) => {
    for (const line of String(s).split(/\r?\n/)) {
      if (!line) continue;
      const row = `[${tag}] ${line}\n`;
      writeSync(svcLog, row);
      console.log(row.trimEnd());
    }
  };

  // 启动本地测试服务
  const svc = spawn(process.execPath, ['dist/index.js'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
  log(`测试服务 pid=${svc.pid} port=${TEST_PORT} log=${join(logDir, `test-instance-${stamp}.log`)}`);
  svc.stdout.on('data', (d) => emit('svc', d));
  svc.stderr.on('data', (d) => emit('svc!', d));
  svc.on('exit', (code) => { emit('svc', `服务退出 exit=${code}`); process.exitCode = code ?? 1; });

  // 健康检查
  const health = `http://127.0.0.1:${TEST_PORT}/health`;
  let ok = false, tools = 0;
  for (let i = 0; i < 60 && !ok; i++) {
    await new Promise((r) => setTimeout(r, 500));
    try {
      const res = await fetch(health);
      if (res.ok) { const j = await res.json(); tools = j.tools ?? j.toolCount ?? -1; ok = true; }
    } catch { /* not up yet */ }
  }
  if (ok) log(`健康检查通过: ${health} (tools=${tools})`);
  else log(`警告: 60 秒内健康检查未通过，查看日志确认（新代码工具数应 ≥42）`);

  // 可选：独立测试隧道（方案 B，UUID 显式指定）
  if (WITH_TUNNEL) {
    const tunnelLog = openSync(join(logDir, `test-tunnel-${stamp}.log`), 'a');
    const tunnel = spawn('cloudflared', ['tunnel', '--config', TUNNEL_CONFIG, 'run', tunnelUuid], {
      cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'],
    });
    log(`测试隧道 pid=${tunnel.pid} uuid=${tunnelUuid} log=${join(logDir, `test-tunnel-${stamp}.log`)}`);
    tunnel.stdout.on('data', (d) => { try { writeSync(tunnelLog, d); } catch {} });
    tunnel.stderr.on('data', (d) => { try { writeSync(tunnelLog, d); } catch {} });
    tunnel.on('exit', (code) => { emit('tunnel', `隧道退出 exit=${code}`); });
  }

  // Ctrl+C 只收自己的孩子，不碰生产
  process.on('SIGINT', () => { log('收到 SIGINT，停止测试实例（生产不受影响）'); svc.kill(); process.exit(0); });
  log(`就绪。对外地址: https://mcp-test.zxc66.asia/mcp`);
}

main().catch((e) => die(e?.stack || String(e)));
