# feishu_mcp

将本地文件系统安全地暴露给飞书 Aily AI 助手的 MCP（Model Context Protocol）服务。

通过 Streamable HTTP 协议，让飞书 Aily 中的 AI Agent 能够远程读写你本机的文件——读取文档、写入代码、搜索目录、编辑文件，全程经过 Bearer Token 鉴权和多层安全防护。

## 为什么需要它

飞书 Aily 的 AI 助手运行在云端，无法直接访问你本地电脑的文件。`feishu_mcp` 在你的本机启动一个 MCP 服务，通过 ngrok 内网穿透将服务暴露到公网，让 Aily 可以像调用普通 API 一样操作你的本地文件系统。

```
飞书 Aily (云端)  →  HTTPS  →  ngrok 隧道  →  本地 MCP Server  →  文件系统
                        ↑                        ↑
                  Bearer Token 鉴权       目录白名单 + 安全防护
```

## 功能

提供 10 个 MCP 工具，覆盖完整的文件系统操作：

| 工具 | 功能 | 读/写 |
|------|------|-------|
| `ping` | 健康检查，验证服务连通性 | — |
| `read_file` | 读取文件内容（文本/二进制自动识别） | 读 |
| `write_file` | 写入或覆盖文件 | 写 |
| `edit_file` | 精确文本替换（支持 dry-run 预览） | 写 |
| `create_directory` | 递归创建目录 | 写 |
| `list_directory` | 列出目录内容 | 读 |
| `move_file` | 移动或重命名文件 | 写 |
| `search_files` | 递归搜索文件（支持排除模式） | 读 |
| `get_file_info` | 获取文件元数据（大小、权限、修改时间） | 读 |
| `list_allowed_directories` | 列出当前允许访问的目录 | 读 |

## 安全特性

服务暴露在公网，安全是第一优先级：

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

### 1. 安装

```bash
git clone https://github.com/zhuxice-ctrl/feishu_mcp.git
cd feishu_mcp
npm install
```

### 2. 配置环境变量

```bash
cp .env.example .env
```

编辑 `.env`，设置允许访问的目录和鉴权 Token：

```env
# 允许访问的目录（逗号分隔）
# Windows: ALLOWED_DIRS=D:\AilyWorkspace
# macOS/Linux: ALLOWED_DIRS=/Users/yourname/Documents
ALLOWED_DIRS=/path/to/your/workspace

# Bearer Token（生成一个随机字符串）
# Linux/macOS: openssl rand -hex 32
# 或随便填一个你自己的强密码
MCP_AUTH_TOKEN=your-secret-token
```

完整配置项见 `.env.example`。

### 3. 启动 MCP 服务

```bash
npm run build
npm start
```

服务默认监听 `http://localhost:3000`。验证是否正常：

```bash
# 健康检查
curl http://localhost:3000/health

# 测试 MCP 工具调用
curl -X POST http://localhost:3000/mcp \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -H "Authorization: Bearer your-secret-token" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}'
```

### 4. 配置 ngrok 内网穿透

本地服务需要通过公网地址才能被飞书 Aily 访问。使用 ngrok 免费版即可获得固定公网域名，效果与 Cloudflare Tunnel 相同。

#### 4.1 注册 ngrok 账号

打开 https://dashboard.ngrok.com/signup （可以用 GitHub / Google 直接登录）

#### 4.2 获取 Auth Token

登录后访问 https://dashboard.ngrok.com/get-started/your-authtoken

- 页面上会显示一串类似 `2abc1XYZ...` 的 token
- 复制这个 token

#### 4.3 领取免费固定域名

访问 https://dashboard.ngrok.com/domains

- 点击 "Create Domain" 或 "Claim Domain"
- ngrok 会免费给你一个固定的子域名，比如 `xxx-xxx-xxx.ngrok-free.app`
- 把这个域名记下来

#### 4.4 安装并配置 ngrok

```bash
# 安装 ngrok（任选一种方式）

# macOS (Homebrew)
brew install ngrok/ngrok/ngrok

# Windows (Chocolatey)
choco install ngrok

# 或直接下载: https://ngrok.com/download

# 配置 Auth Token
ngrok config add-authtoken YOUR_NGROK_AUTHTOKEN
```

#### 4.5 启动隧道

```bash
# 将本地 3000 端口映射到你的固定域名
ngrok http 3000 --domain=your-domain.ngrok-free.app
```

看到 `Forwarding https://your-domain.ngrok-free.app -> http://localhost:3000` 就说明隧道已建立。

验证公网可达：

```bash
curl https://your-domain.ngrok-free.app/health
```

> **提示**：ngrok 免费版提供 1 个固定域名，完全满足个人使用。隧道需要保持运行，关闭终端会断开。Windows 可用 `scripts/start-ngrok.ps1` 一键启动服务 + 隧道。

### 5. 接入飞书 Aily

1. 打开飞书 Aily 管理后台
2. 进入 **MCP 管理** → **添加 MCP** → 选择 **企业自定义 MCP**
3. 填写配置：

| 字段 | 值 |
|------|------|
| 名称 | 本地文件助手 |
| 请求地址 | `https://your-domain.ngrok-free.app/mcp` |
| Endpoint 类型 | **Streamable HTTP** |

4. 添加请求参数用于鉴权：

| 字段 | 值 |
|------|------|
| 参数名 | `Authorization` |
| 参数位置 | **Header** |
| 参数值 | `Bearer your-secret-token` |
| 传值方式 | **用户输入** |

5. 在 Aily 助手对话中添加该 MCP，输入你的 Token，即可使用

详细接入步骤见 [飞书 Aily MCP 接入指南](docs/aily-integration-guide.md)。

## 使用示例

在飞书 Aily 中对 AI 助手说：

```
请用本地文件助手的 ping 工具，消息写 hello
请列出 D:\AilyWorkspace 目录的内容
请读取 D:\AilyWorkspace\hello.txt 文件
请搜索 D:\AilyWorkspace 下所有 .py 文件
```

AI 会通过 MCP 工具直接操作你本机的文件。

## 项目结构

```
feishu_mcp/
├── src/
│   ├── index.ts                  # 入口：Express 服务 + MCP 路由（AsyncLocalStorage 传递 token）
│   ├── config.ts                 # 配置：环境变量集中管理 + SERVER_NAME/SERVER_VERSION 单一来源
│   ├── security/
│   │   ├── auth.ts               # Bearer Token + 频率限制中间件
│   │   ├── requestContext.ts     # AsyncLocalStorage 传递每请求 token
│   │   ├── pathGuard.ts          # 路径白名单 + 穿越防护
│   │   ├── fileGuard.ts          # 文件类型黑名单 + 敏感文件过滤
│   │   ├── rateLimit.ts          # 滑动窗口限流
│   │   ├── logger.ts             # 操作审计日志（token 哈希存储）
│   │   └── trash.ts              # 软删除回收站
│   └── tools/
│       ├── filesystem.ts         # 9 个文件系统工具（注册入口）
│       ├── helpers.ts            # 共享：resolveAndGuard / withToolHandler / 文本二进制判定
│       └── atomicWrite.ts        # 原子写：tmp + rename
├── scripts/
│   └── start-ngrok.ps1           # Windows 一键启动（服务 + 隧道）
├── docs/
│   └── aily-integration-guide.md # 飞书 Aily 接入指南
├── test/
│   ├── e2e_test.py               # 端到端测试（37 项）
│   └── debug_mcp.py              # 调试工具
├── .env.example                  # 环境变量模板
├── package.json
├── tsconfig.json
└── README.md
```

## 重构说明（2026-07）

本仓库在 v1.0.0 基础上做了一次以「行为零变化 + 代码质量提升」为目标的重构，提交在 `refactor/code-quality` 分支（待合并）。主要改动：

- **每请求 token 通过 AsyncLocalStorage 传递**，替代原先的模块级 `currentToken` 变量，修复了并发请求下审计日志串号与 token 残留的隐患（见 `src/security/requestContext.ts`）。
- **SERVER_NAME / SERVER_VERSION 提到 `config.ts`**，消除 `package.json`、`McpServer`、`/health`、e2e 测试四处不一致；e2e 期望值同步更新。
- **`auth.ts` 的 `X-RateLimit-Limit` 头改用 `RATE_LIMIT_PER_MIN`**，配置变更不再与硬编码 60 漂移。
- **写入原子化**：`write_file` / `edit_file` 改用「写 `.tmp` + `rename` 覆盖」流程（`src/tools/atomicWrite.ts`），杜绝写失败导致原文件已进回收站、目标文件丢失的数据风险；rename 跨盘失败时降级 copy + unlink。
- **工具样板收敛**：`src/tools/helpers.ts` 抽出 `resolveAndGuard` / `withToolHandler` / `errorResult` / `textContent` / 文本二进制判定 / 字节格式化，`filesystem.ts` 从 662 行降至 ~500 行，每个工具函数体更聚焦。
- **死代码清理**：删除 `getTokenFromContext`、未使用的 `MCP_AUTH_TOKEN` 导入、`pathGuard` 中空的 `.trash` 循环、`trash.ts` 重复的 `ALLOWED_DIRS` 导入。
- **search_files 的 glob 预编译**为 RegExp（原本每条目每目录重编译一次）。
- e2e 测试从 37/37 通过保持不变（行为兼容）。

## 技术栈

- **TypeScript** + **Node.js** (ESM)
- **@modelcontextprotocol/server** v2 (MCP SDK v2)
- **@modelcontextprotocol/express** (Express HTTP transport)
- **Express** 4.x
- **Zod** v4 (Schema validation)
- **ngrok** (内网穿透)

## 开发

```bash
# 安装依赖
npm install

# 开发模式（热重载）
npm run dev

# 构建
npm run build

# 类型检查
npm run typecheck

# 端到端测试（需先构建）
npm run build && python3 test/e2e_test.py
```

## License

MIT
