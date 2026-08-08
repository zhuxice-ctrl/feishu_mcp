# feishu_mcp：个人本地开发工作台 MCP

> 部署前请先阅读 [SECURITY.md](SECURITY.md)。每台电脑必须使用自己的 `.env`、
> `MCP_AUTH_TOKEN`、授权目录、ngrok 地址和 Aily MCP 配置。不要共享或提交这些信息。

这是一个运行在你自己电脑上的 MCP（Model Context Protocol）服务。它让飞书 Aily
工作台在受控范围内访问本机项目：读写文件、查看 Git、运行构建与测试、检查 Android
或 Windows 开发环境，并安全导入二进制制品。

```text
你的 Aily 工作台  →  HTTPS 隧道  →  你电脑上的 MCP  →  你的项目目录与工具链
                         Bearer 鉴权       目录边界、审批、审计和限额
```

源代码可以通过 Git 分享；Token、ngrok authtoken、`.env`、日志、审批数据、构建输出和
个人路径不能分享。

## 10 分钟个人接入

### 1. 克隆并安装

```powershell
git clone https://github.com/zhuxice-ctrl/feishu_mcp.git
cd feishu_mcp
npm install
```

### 2. 创建自己的本地配置

复制 `.env.example` 为 `.env`，然后只填写自己的项目目录和随机生成的 Token。不要把
其他电脑的 `.env` 复制过来。

```env
# 只授权自己的项目根目录；可用逗号分隔多个目录
ALLOWED_DIRS=F:\MyProjects

# 自己生成的长随机值；不要提交、截图或发送给他人
MCP_AUTH_TOKEN=<your-own-random-token>

# 个人部署的默认安全模式
AUTH_MODE=pin
AUTH_PIN=<your-own-strong-pin>
AUTH_USER_HEADER=x-aily-user

# 命令默认仍需确认
OWNER_COMMAND_POLICY=approval
```

`AUTH_MODE=none` 仅适合完全由你自己控制的个人入口；即使使用它，也应保留
`MCP_AUTH_TOKEN`。

### 3. 启动本地 MCP

Windows 推荐双击仓库根目录的：

```text
start-feishu-mcp.bat
```

启动器会构建服务、检查本地健康状态并启动或检查 ngrok 通道。你也可以手动运行：

```powershell
npm run build
npm start
```

本地健康检查：

```powershell
Invoke-RestMethod http://127.0.0.1:3000/health
```

正常时应返回 `status: ok`，并报告 31 个工具。若你使用 Clash Fake-IP，启动器对公网
`/health` 的回访失败只会警告；本地服务和隧道仍可正常工作。

### 4. 手动配置自己的 ngrok

在你自己的 ngrok 账号中完成以下操作：安装 ngrok、保存自己的 authtoken，并为本地
`127.0.0.1:3000` 建立 HTTPS 隧道。使用临时域名时，每次重启隧道都可能变化；使用保留
域名时，请按你的 ngrok 账号能力配置。

隧道建立后，记下自己的 HTTPS 地址，并确认：

```text
https://<your-ngrok-domain>/health
```

可访问。不要把这条地址当作凭据，也不要把它复制给其他使用者。

### 5. 在 Aily 添加 MCP

在 Aily 中添加企业自定义 MCP，Endpoint 类型选 **Streamable HTTP**：

```text
MCP endpoint: https://<your-ngrok-domain>/mcp
Authorization: Bearer <your-own-MCP_AUTH_TOKEN>
x-aily-user: <your-own-OWNER_USER_ID>
```

`Authorization` 和 `x-aily-user` 必须添加在**请求头**中。`Bearer ` 加 Token 必须填入
真正的请求头输入值；展示名称或描述栏只显示说明，不会发送该值。

保存或更新 MCP 后，重新打开 Aily 对话并调用 `ping` 或让它枚举工具。出现 401 时，先
核对 Token 是否与本机 `.env` 一致，以及是否包含 `Bearer ` 前缀。

## Android 与 Windows 本地开发环境

项目内提供 [个人 MCP 接入教学 Skill](skills/personal-mcp-onboarding/SKILL.md)。它适合
让 Aily 或 Codex 先检查你的设备，再给出**手动**安装与接入步骤。

它会按项目需要检查：

- Node.js、npm、Git、本地 MCP、ngrok；
- Android Studio、Android SDK、JDK、Gradle wrapper、`adb`；
- Visual Studio Build Tools、MSVC、Windows SDK、CMake。

它不会替你注册 ngrok、安装软件、填写 Token、修改 `.env` 或改变系统环境。示例提问：

```text
检查我的 Windows 电脑是否能运行这个 MCP，并给我手动接入 Aily 的步骤。
检查这个 Android 项目缺少哪些 SDK、JDK 和 adb 配置，只给我手动修复方法。
检查这个 Windows 原生项目需要的 MSVC、Windows SDK 和 CMake 环境。
```

## 能力概览：31 个工具

工具清单由服务在 `tools/list` 中实际返回；Aily 的文字总结可能合并或漏列工具，
应以该响应和 `/health` 为准。

| 分组 | 工具 |
|---|---|
| 连通与授权 | `ping`、`auth`、`list_allowed_directories` |
| 文件与目录 | `read_file`、`write_file`、`edit_file`、`create_directory`、`list_directory`、`move_file`、`search_files`、`search_content`、`get_file_info`、`compare_files`、`apply_patch` |
| 命令与 Git | `execute_command`、`git_status`、`git_diff` |
| 网络与任务 | `web_fetch`、`todo_write`、`todo_read`、`ask_user` |
| 开发环境 | `get_development_task`、`read_development_task_logs`、`cancel_development_task`、`inspect_development_environment`、`plan_environment_changes`、`apply_environment_plan`、`android_development`、`windows_development`、`manage_development_project` |
| 二进制制品 | `manage_binary_artifact` |

`manage_binary_artifact` 用于验证、分块接收、存储和原子落盘 PNG、ZIP 等二进制制品；
它不提供任意二进制执行或解压能力。二进制构建产物通常应放在制品存储或 Release，
而不是提交到 Git。

## 构建与测试命令

现有的 `execute_command` 是唯一的命令执行工具。它只能在已授权目录中运行，并受目录
边界、受保护内部目录、超时、输出上限、取消、并发限制和审计约束。

默认策略：

```env
OWNER_COMMAND_POLICY=approval
```

个人设备所有者确实需要让构建和测试直通时，才可以显式配置：

```env
OWNER_USER_ID=<your-own-owner-id>
OWNER_COMMAND_POLICY=direct
```

`direct` 仅跳过该 Owner 的普通单次命令审批；它不会放宽目录权限、内部数据保护、超时、
输出限制、取消、审计或并发限制。非 Owner 仍遵循普通审批流程。包安装和构建脚本可能
联网或产生外部副作用，不能视为可由回收站完全回滚的操作。

## 安全模型

- **传输鉴权**：`MCP_AUTH_TOKEN` 保护公网 MCP 入口，错误或缺失会返回 401。
- **工具授权**：支持 `pin`、`header` 和 `none`；公网 `header` 模式只能放在可信网关后。
- **目录白名单**：仅允许 `ALLOWED_DIRS` 中的项目目录，解析后防止路径穿越和符号链接逃逸。
- **操作确认**：文件写入、风险命令、敏感路径与首次网络来源按策略要求确认。
- **审计与限流**：操作写入审计日志，Token 仅以哈希形式记录；并发、频率、大小和时间均有上限。
- **软删除**：覆盖或移动文件会先进入项目的 `.trash/`；它不保证撤销网络、包管理器或外部系统副作用。

永远不要以管理员身份运行 MCP。不要把整个磁盘授权给日常 Aily 对话；优先只授权一个
项目根目录。

## 常见问题

### Aily 显示 401 或没有工具

检查顺序：本地 `/health` 是否正常、ngrok 是否在线、Aily endpoint 是否为 `/mcp`、
`Authorization` 是否位于请求头、值是否为 `Bearer <your token>`。Aily 的描述栏不会
代替真实请求头输入。

### Aily 的文字回答只列出一部分工具

这是模型的概括，不代表服务只暴露了这些工具。让它调用 `tools/list`，或检查
`/health` 的工具清单；当前服务应返回 31 个工具。

### 启动器报告公网 health 超时

在 Clash Fake-IP 等本机 DNS 场景可能发生。确认 `http://127.0.0.1:3000/health` 和 ngrok
隧道状态；启动器不会因为该公网回访警告停止健康的本地服务。

### Android 或 Windows 构建环境缺失

使用 [个人 MCP 接入教学 Skill](skills/personal-mcp-onboarding/SKILL.md) 先检测，再按
Android Studio SDK Manager 或 Visual Studio Installer 的手动步骤安装相应组件。

## 项目结构

```text
feishu_mcp/
├── src/                         # MCP 服务、鉴权、工具和安全边界
├── scripts/                     # Windows 启动器与辅助脚本
├── skills/
│   └── personal-mcp-onboarding/ # 个人电脑接入教学 Skill
├── docs/                        # 设计、计划与接入参考
├── test/                        # Node 测试
├── .env.example                 # 本地配置模板，不含真实密钥
├── start-feishu-mcp.bat         # Windows 启动入口
└── SECURITY.md                  # 安全部署要求
```

## 开发与验证

```powershell
npm install
npm run build
npm run typecheck
```

运行某一组测试时使用 Node 内置测试运行器，例如：

```powershell
node --test test/launcher.test.mjs
```

完整配置项以 `.env.example` 和 `src/config.ts` 为准；详细 Aily 接入说明见
[docs/aily-integration-guide.md](docs/aily-integration-guide.md)。

## License

MIT
