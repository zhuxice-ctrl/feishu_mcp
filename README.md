# aily-local-file-mcp

飞书 Aily 本地文件 MCP 服务 — 通过 Streamable HTTP 协议安全暴露本地文件系统给 AI 助手。

## 架构

```
飞书 Aily → HTTPS → Cloudflare Tunnel → 本地 HTTP MCP Server → 文件系统
                ↑                         ↑
          Bearer Token 鉴权        目录白名单 + 安全防护
```

## 功能

10 个 MCP 工具，覆盖完整的文件系统操作：

| 工具 | 功能 | 读写 |
|------|------|------|
| `ping` | 健康检查 | — |
| `read_file` | 读取文件内容（文本/二进制） | 读 |
| `write_file` | 写入/覆盖文件 | 写 |
| `edit_file` | 精确文本替换（支持 dry-run） | 写 |
| `create_directory` | 创建目录（递归） | 写 |
| `list_directory` | 列出目录内容 | 读 |
| `move_file` | 移动/重命名文件 | 写 |
| `search_files` | 递归搜索文件 | 读 |
| `get_file_info` | 获取文件元数据 | 读 |
| `list_allowed_directories` | 列出允许访问的目录 | 读 |

## 安全特性

- **Bearer Token 鉴权** — 每个请求验证 Token，未授权返回 401
- **目录白名单** — 仅允许 `ALLOWED_DIRS` 配置的目录，其余路径一律拒绝
- **路径穿越防护** — 解析后检查是否在白名单内，检测符号链接逃逸
- **文件类型黑名单** — 拦截 `.exe` / `.bat` / `.ps1` / `.dll` 等可执行文件
- **敏感文件过滤** — 拦截 `.env` / SSH 密钥 / 浏览器数据等
- **文件大小限制** — 读取 10MB / 写入 5MB
- **频率限制** — 每分钟 60 次请求（可配置）
- **操作审计日志** — JSON 格式记录所有操作，Token 哈希存储
- **软删除回收站** — 文件覆盖/移动前备份到 `.trash/`，保留 7 天

## 快速开始

### 安装

```bash
git clone https://github.com/zhuxice-ctrl/aily-local-file-mcp.git
cd aily-local-file-mcp
npm install
```

### 配置

```bash
cp .env.example .env
# 编辑 .env，设置 ALLOWED_DIRS 和 MCP_AUTH_TOKEN
```

关键配置项：

```env
# 允许访问的目录（逗号分隔）
ALLOWED_DIRS=/path/to/your/workspace

# Bearer Token（生成: openssl rand -hex 32）
MCP_AUTH_TOKEN=your-secret-token

# 端口（默认 3000）
PORT=3000
```

### 运行

```bash
# 构建
npm run build

# 启动
npm start

# 开发模式（热重载）
npm run dev
```

### 验证

```bash
# 健康检查
curl http://localhost:3000/health

# MCP 工具列表
curl -X POST http://localhost:3000/mcp \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}'

# 端到端测试
python3 test/e2e_test.py
```

## 部署

### Cloudflare Tunnel（公网暴露）

1. 安装 cloudflared（Windows 脚本）：

```powershell
# 以管理员运行
.\scripts\install-cloudflared-windows.ps1
```

2. 创建命名 Tunnel：

```bash
cloudflared tunnel login
cloudflared tunnel create aily-mcp
cloudflared tunnel route dns aily-mcp aily-mcp.yourdomain.com
```

3. 编辑 `cloudflared/config.yml`，替换 `<TUNNEL_ID>`

4. 注册为系统服务（开机自启）：

```powershell
# 以管理员运行
.\scripts\install-service-windows.ps1
```

详细配置见 `cloudflared/config.yml` 和 `scripts/` 目录。

### 飞书 Aily 接入

详见 [飞书 Aily MCP 接入指南](docs/aily-integration-guide.md)。

## 项目结构

```
aily-local-file-mcp/
├── src/
│   ├── index.ts              # 入口：Express 服务 + MCP 路由
│   ├── config.ts             # 配置：环境变量集中管理
│   ├── security/
│   │   ├── auth.ts           # Bearer Token + 频率限制中间件
│   │   ├── pathGuard.ts      # 路径白名单 + 穿越防护
│   │   ├── fileGuard.ts      # 文件类型黑名单 + 敏感文件过滤
│   │   ├── rateLimit.ts      # 滑动窗口限流
│   │   ├── logger.ts         # 操作审计日志
│   │   └── trash.ts          # 软删除回收站
│   └── tools/
│       └── filesystem.ts     # 9 个文件系统工具
├── cloudflared/
│   └── config.yml            # Cloudflare Tunnel 配置模板
├── scripts/
│   ├── install-cloudflared-windows.ps1  # Windows 安装脚本
│   ├── start-tunnel.ps1                 # 启动 Quick Tunnel
│   └── install-service-windows.ps1      # 注册系统服务
├── docs/
│   └── aily-integration-guide.md  # 飞书 Aily 接入指南
├── test/
│   ├── e2e_test.py           # 端到端测试（37 项）
│   └── debug_mcp.py          # 调试工具
├── .env.example              # 环境变量模板
├── package.json
├── tsconfig.json
└── README.md
```

## 技术栈

- **TypeScript** + **Node.js** (ESM)
- **@modelcontextprotocol/server** v2.0.0-beta.5 (MCP SDK v2)
- **@modelcontextprotocol/express** (Express HTTP transport)
- **Express** 4.x
- **Zod** v4 (Schema validation)
- **Cloudflare Tunnel** (公网暴露)

## 开发阶段

- [x] **Phase 1** — 项目初始化 + HTTP MCP Server 骨架
- [x] **Phase 2** — 9 个文件系统工具实现
- [x] **Phase 3** — 安全层加固（鉴权、路径防护、审计、软删除）
- [x] **Phase 4** — Cloudflare Tunnel 部署配置
- [x] **Phase 5** — 飞书 Aily 接入指南 + 端到端测试

## License

MIT
