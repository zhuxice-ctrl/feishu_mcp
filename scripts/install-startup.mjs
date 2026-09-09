// install-startup.mjs — 把 startup-launcher.js 安装到当前用户 Startup 文件夹（开机自启）
import { copyFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
const src = resolve(import.meta.dirname, 'startup-launcher.js');
const dst = join(process.env.APPDATA, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup', 'feishu-mcp-supervisor.js');
copyFileSync(src, dst);
console.log('COPIED -> ' + dst);
