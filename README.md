# feishu_mcp

将本地文件系统安全地暴露给飞书 Aily AI 助手的 MCP（Model Context Protocol）服务。

通过 Streamable HTTP 协议，让飞书 Aily 中的 AI Agent 能够远程读写你本机的文件——读取文档、写入代码、搜索目录、编辑文件。服务同时支持可选的 Bearer 传输层鉴权，以及 PIN / 可信身份头工具授权。

## 为什么需要它

飞书 Aily 的 AI 助手运行在云端，无法直接访问你本地电脑的文件。`feishu_mcp` 在你的本机启动一个 MCP 服务，通过 ngrok 内网穿透将服务暴露到公网，让 Aily 可以像调用普通 API 一样操作你的本地文件系统。

```
飞书 Aily (云端)  →  HTTPS  →  ngrok 隧道  →  本地 MCP Server  →  文件系统
                        ↑                        ↑
              Bearer 传输鉴权（可选）   工具授权 + 目录白名单 + 飞书窗口内确认
```

## 功能

提供 21 个 MCP 工具，组成完整的本地开发环境：

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
| `auth` | 使用 PIN 为当前请求身份取得工具权限 | — |
| `execute_command` | 在允许目录内运行命令；高风险命令先请求确认 | 执行 |
| `search_content` | 按文本或正则搜索文件内容 | 读 |
| `git_status` | 查看 Git 分支与工作区状态 | 读 |
| `git_diff` | 查看暂存或未暂存差异 | 读 |
| `compare_files` | 比较两个文件并返回 unified diff | 读 |
| `apply_patch` | 事务式应用单文件或多文件补丁，失败时回滚 | 写 |
| `web_fetch` | 获取 HTTP/HTTPS 内容；按来源域确认 | 网络 |
| `todo_write` | 替换当前用户的内存任务列表 | 状态 |
| `todo_read` | 读取当前用户的内存任务列表 | 状态 |
| `ask_user` | 在飞书对话中显示补充信息/选择卡片 | 交互 |

## 安全特性

服务暴露在公网，安全是第一优先级：

- **Bearer Token 传输鉴权** — 可选的公网入口共享密钥，未授权返回 401
- **工具级授权** — `pin` / `header` / `none` 三种模式；PIN 用户状态按请求身份隔离
- **目录白名单** — 仅允许 `ALLOWED_DIRS` 配置的目录，其余路径一律拒绝
- **路径穿越防护** — 解析后检查是否在白名单内，检测符号链接逃逸
- **文件类型黑名单** — 拦截 `.exe` / `.bat` / `.ps1` / `.dll` 等可执行文件
- **飞书窗口内确认** — 需要授权时显示 `本次允许`、`本次启动期间允许`、`永久允许`、`拒绝`；不要求回到终端
- **严格客户端策略** — 客户端不支持 MCP `input_required` 时拒绝受保护操作，不回退到终端、浏览器或纯文本确认
- **精确永久授权** — 永久许可按用户、工具与目标精确保存，可用 `manage-feishu-mcp-approvals.bat` 查看或撤销
- **命令风险分类** — 仅明确识别的只读命令自动执行；写操作、管道、重定向、解释器、包管理器和不明确命令均需确认
- **有界并发** — 全局以及命令、搜索、网络分别设置并发上限，互不依赖的调用可并行执行
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

编辑 `.env`，设置允许访问的目录、传输 Token 和工具授权方式：

```env
# 允许访问的目录（逗号分隔）
# Windows: ALLOWED_DIRS=D:\AilyWorkspace
# macOS/Linux: ALLOWED_DIRS=/Users/yourname/Documents
ALLOWED_DIRS=/path/to/your/workspace

# Bearer Token（生成一个随机字符串）
# Linux/macOS: openssl rand -hex 32
# 或随便填一个你自己的强密码
MCP_AUTH_TOKEN=your-secret-token

# 默认 pin 模式要求显式配置至少 8 个字符的 PIN，PIN 不会打印到日志
AUTH_MODE=pin
AUTH_PIN=replace-with-a-strong-pin
AUTH_USER_HEADER=x-aily-user

# 绝对路径/敏感文件可选 allow、confirm 或 deny；confirm 在飞书窗口内显示确认卡片
CONSENT_ABSOLUTE_PATH=confirm
CONSENT_SENSITIVE_FILE=confirm
NON_INTERACTIVE=deny

# 可按机器性能调整；默认总并发 8、命令 2、搜索 2、网络 4
MAX_CONCURRENT_TOOLS=8
MAX_CONCURRENT_COMMANDS=2
MAX_CONCURRENT_SEARCHES=2
MAX_CONCURRENT_FETCHES=4
```

企业内部、仅设备所有者使用的部署可改用以下固定身份配置（不在此处放入任何
Token、PIN 或其他密钥）：

```env
ALLOWED_DIRS=
OWNER_USER_ID=owner
OWNER_DEFAULT_DIRS=F:\
DIRECTORY_APPROVAL_FALLBACK=owner
```

在这种部署中，企业内部 MCP 工具必须只对设备所有者可见：Aily 配置固定请求头
`x-aily-user=owner`，不要把该 MCP 暴露给会携带其他身份的用户。`F:\` 只会作为
`owner` 的默认目录，其他身份不能继承它。

当前飞书/Aily 客户端如果不支持 MCP `input_required`，owner 专属 fallback 会让
原文件工具返回一个签名、限时、一次性的目录挑战。智能体必须先在会话中展示
“本次允许 / 会话允许 / 永久允许 / 拒绝”，得到明确选择后调用现有 `auth` 工具
提交决定，并立即用原参数重试原工具。这个流程不修改 `ALLOWED_DIRS`，也不需要
重启服务。`DIRECTORY_APPROVAL_FALLBACK` 默认是 `deny`；只有私有、固定 owner
身份的工具应配置为 `owner`。

### 两层鉴权的区别

- `MCP_AUTH_TOKEN` 是可选的传输层共享密钥，适合保护 ngrok 公网入口。
- `AUTH_MODE=pin` 会要求每个 `x-aily-user` 身份先调用 `auth` 工具；这是默认模式。
- `AUTH_MODE=none` 关闭工具级授权，但仍可保留 Bearer Token，适合只需要单一共享密钥的个人部署。
- `AUTH_MODE=header` 信任上游注入的身份头。通过公网使用时，必须由可信网关删除客户端自带身份头后重新注入；不要让 ngrok 直接把任意客户端身份头透传给此模式。

完整配置项见 `.env.example`。

### 目录确认卡片与永久授权

高风险命令、首次访问的网络来源，以及策略要求确认的路径会在当前飞书对话中显示补充信息卡片。目录首次超出当前范围时，会显示四个选择：“本次允许”、“当前服务进程内允许”、“永久允许”和“拒绝”。批准后，原工具调用会自动重试；拒绝时不会执行该操作。选择“永久允许”只会保存卡片上展示的精确范围，不会给整个磁盘或全部命令放行。

MCP 自身的授权数据目录、审批数据库、签名密钥及其子路径是唯一不可授权的内部数据范围。管理本地永久操作许可与目录许可：

```text
manage-feishu-mcp-approvals.bat
manage-feishu-mcp-approvals.bat -ListDirectories
manage-feishu-mcp-approvals.bat -RemoveDirectory <编号或ID前缀>
manage-feishu-mcp-approvals.bat -ClearDirectories
```

目录列表只显示编号、ID 前缀、不可逆用户哈希、磁盘/卷标与目录名，不显示完整路径或原始身份。目录授权不会增加 MCP 工具：`tools/list` 始终返回 21 个工具。

任务列表仅保存在当前 Node 进程内并按 `x-aily-user` 隔离，重启服务后自动清空。

并发与超时可通过 `MAX_CONCURRENT_*`、`*_TIMEOUT_MS`、搜索上限和响应字节上限调整；完整默认值见 `.env.example`。

### 3. 启动 MCP 服务

#### Windows 一键启动本地服务与固定通道

先在 `.env` 中配置 `NGROK_DOMAIN`，并完成一次 ngrok authtoken 配置。然后
双击仓库根目录的：

```text
start-feishu-mcp.bat
```

启动器会自动构建项目、启动本地 MCP、建立固定 ngrok 通道，并验证本地和
公网 `/health`。成功后会显示并复制飞书 Aily 所需的 `/mcp` 地址。按
`Q`、`Enter` 或 `Ctrl+C` 会清理本次启动的 Node 和 ngrok 子进程。

启动器优先使用 PATH 中的 `ngrok`；若未加入 PATH，则会自动查找仓库同级
`ngrok/ngrok.exe`。它不会打印 `.env` 中的 Bearer Token、PIN 或 ngrok
authtoken。

#### 手动启动本地服务

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
ngrok http http://127.0.0.1:3000 --url=https://your-domain.ngrok-free.app
```

看到 `Forwarding https://your-domain.ngrok-free.app -> http://localhost:3000` 就说明隧道已建立。

验证公网可达：

```bash
curl https://your-domain.ngrok-free.app/health
```

> **提示**：ngrok 免费版提供 1 个固定域名，完全满足个人使用。隧道需要保持运行，关闭终端会断开。Windows 推荐双击根目录的 `start-feishu-mcp.bat`；`scripts/start-ngrok.ps1` 保留为旧版手动入口。

### 5. 接入飞书 Aily

1. 打开飞书 Aily 管理后台
2. 进入 **MCP 管理** → **添加 MCP** → 选择 **企业自定义 MCP**
3. 填写配置：

| 字段 | 值 |
|------|------|
| 名称 | 本地文件助手 |
| 请求地址 | `https://your-domain.ngrok-free.app/mcp` |
| Endpoint 类型 | **Streamable HTTP** |

4. 添加 `Authorization` 请求头用于可选的传输层鉴权。若使用默认 PIN 模式，还需确保平台为每次请求提供稳定的 `x-aily-user` 身份，并先调用 `auth` 工具完成认证。

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
请在 D:\AilyWorkspace 中搜索包含 TODO 的代码，并按文件汇总
请查看这个仓库的 git status 和未暂存 diff
请比较 D:\AilyWorkspace\before.txt 与 after.txt
请应用下面这个多文件补丁；写入前把变更目标告诉我
请在当前仓库运行只读命令 git status
请读取 https://example.com 的正文；如果需要来源授权就在飞书里让我确认
请建立一个任务列表，把“修复测试”标成进行中
请在飞书窗口里问我选择开发、测试还是发布环境
```

AI 会通过 MCP 工具直接操作你本机的文件。

## 项目结构

```
feishu_mcp/
├── src/
│   ├── index.ts                  # 入口：Express 服务 + MCP 路由（每请求身份上下文）
│   ├── auth/                     # PIN / header / none 工具授权
│   ├── config.ts                 # 配置：环境变量集中管理 + SERVER_NAME/SERVER_VERSION 单一来源
│   ├── security/
│   │   ├── auth.ts               # Bearer Token + 频率限制中间件
│   │   ├── requestContext.ts     # AsyncLocalStorage 传递 token、用户与邮箱
│   │   ├── consent.ts            # 绝对路径/敏感文件确认策略
│   │   ├── terminal.ts           # 串行终端确认队列
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

## 安全与代码质量整合说明（2026-07）

本仓库在 v1.0.0 基础上整合了代码质量修复与请求级安全边界。主要改动：

- **每请求 token 通过 AsyncLocalStorage 传递**，替代原先的模块级 `currentToken` 变量，修复了并发请求下审计日志串号与 token 残留的隐患（见 `src/security/requestContext.ts`）。
- **SERVER_NAME / SERVER_VERSION 提到 `config.ts`**，消除 `package.json`、`McpServer`、`/health`、e2e 测试四处不一致；e2e 期望值同步更新。
- **`auth.ts` 的 `X-RateLimit-Limit` 头改用 `RATE_LIMIT_PER_MIN`**，配置变更不再与硬编码 60 漂移。
- **事务安全写入**：`write_file` / `edit_file` 先写入并同步同目录临时文件，再保留旧文件并完成替换；任何阶段失败都会清理半成品并恢复原文件。
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
