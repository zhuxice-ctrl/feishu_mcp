# 飞书 MCP 一键本地服务与固定 ngrok 通道设计

## 目标

为 Windows 用户提供一个可双击运行的入口，同时启动本地
`feishu_mcp` 服务和固定 ngrok 公网通道。启动器必须完成构建、健康检查、
公网验证和子进程清理，并且不能在控制台或日志中泄露 Bearer Token、PIN、
Authorization Header 或 ngrok authtoken。

固定公网地址为：

```text
https://reptilian-prenatal-spinster.ngrok-free.dev
```

飞书 Aily 使用的 Streamable HTTP MCP 地址为：

```text
https://reptilian-prenatal-spinster.ngrok-free.dev/mcp
```

## 范围

本次新增根目录双击入口 `start-feishu-mcp.bat`，并新增或重构一个位于
`scripts/` 下的 PowerShell 编排器。编排器复用现有 Node MCP 服务、`.env`
配置、`dist/index.js` 和 ngrok，不引入新的 npm 或 Python 依赖。

本地未提交的 `.env` 增加：

```env
HOST=127.0.0.1
NGROK_DOMAIN=reptilian-prenatal-spinster.ngrok-free.dev
```

`.env.example` 只记录占位域名和使用说明，不写入真实 Token、PIN 或
authtoken。

## 文件与职责

### `start-feishu-mcp.bat`

- 作为双击入口。
- 将工作目录切换到仓库根目录。
- 以 `-NoProfile -ExecutionPolicy Bypass` 调用 PowerShell 编排器。
- 原样返回编排器退出码，并在失败时保留窗口供用户查看错误。
- 不解析或打印 `.env`。

### `scripts/start-feishu-mcp.ps1`

- 以 UTF-8 读取 `.env`，忽略空行和整行注释。
- 仅将配置写入当前编排器和子进程环境；不输出敏感值。
- 校验 Node、npm、`.env`、`MCP_AUTH_TOKEN`、PIN 模式所需的
  `AUTH_PIN`、`ALLOWED_DIRS`、`NGROK_DOMAIN`。
- 优先使用 PATH 中的 `ngrok`；若不存在，回退到仓库同级目录
  `F:\feishu_mcp\ngrok\ngrok.exe` 的相对位置。
- 运行 `npm run build`，构建失败则不启动任何长期进程。
- 启动 `node dist/index.js`，将服务 stdout/stderr 写入 `logs/` 下的启动日志。
- 在有限时间内轮询本地 `/health`，并验证服务版本、工具数量和授权模式。
- 使用 `ngrok http <port> --domain=<NGROK_DOMAIN>` 启动固定通道。
- 轮询 ngrok 本地检查 API `http://127.0.0.1:4040/api/tunnels`，确认公网 URL
  与配置域名一致。
- 请求公网 `/health`，确认通道实际可访问，而不只依赖 ngrok 进程存活。
- 成功后在控制台显示 Health URL 和 MCP URL，并把 MCP URL 复制到剪贴板。
- 持续监控 Node 和 ngrok；任一进程异常退出时报告原因并清理另一个进程。
- 用户按 `Ctrl+C` 或脚本正常退出时终止两个子进程及其进程树。

## 启动流程

```text
双击 BAT
  → 读取并校验非敏感配置
  → npm run build
  → 启动 Node MCP
  → 本地 /health 通过
  → 启动固定 ngrok 通道
  → ngrok inspector 返回固定 URL
  → 公网 /health 通过
  → 显示并复制 /mcp 地址
  → 等待 Ctrl+C
  → 清理 Node 与 ngrok
```

## 错误处理

- `.env` 缺失或必要配置为空：启动前失败并指出缺失的变量名。
- PIN 少于 8 个字符：启动前失败，不显示 PIN 内容。
- 端口已被无关进程占用：不终止该进程，提示用户处理冲突。
- 构建失败：返回 npm 的退出码，不启动 Node/ngrok。
- 本地健康检查超时：显示服务日志末尾的非敏感诊断并清理服务。
- ngrok 配置无效、域名不属于当前账号或通道启动失败：显示 ngrok 错误，
  清理 MCP 服务。
- 公网健康检查超时：保留明确错误信息并清理两个进程。
- 清理操作采用进程 ID 和进程树，不按模糊进程名终止其他 Node/ngrok 实例。

## 安全约束

- 启动器不回显 `.env`，不打印 Token/PIN 长度之外的敏感信息。
- MCP 只监听 `127.0.0.1`，公网访问必须经过 ngrok。
- 固定域名不是秘密，可以出现在脚本输出和文档中。
- ngrok authtoken 继续存放在 ngrok 自身配置文件中，不复制进仓库。
- 保留当前 `AUTH_MODE=pin`、Bearer 鉴权、目录白名单和 consent 策略。
- 公网 `/health` 不包含 Token、PIN 或用户身份。

## 验证

实现完成后执行：

1. `npm run typecheck`。
2. `npm test`。
3. 双击入口等价命令启动，确认本地 `/health` 返回 HTTP 200 和 11 个工具。
4. 确认 ngrok inspector 中的公网 URL 为固定域名。
5. 确认公网 `/health` 返回 HTTP 200。
6. 确认剪贴板中的地址以 `/mcp` 结尾。
7. 检查控制台与启动日志中不包含 `.env` 的 Token、PIN 或 Authorization 值。
8. 终止启动器后确认本次启动的 Node/ngrok 子进程退出，端口 3000 和 4040
   不再由这些子进程监听。

## 不在范围内

- 不把 MCP 注册为 Windows 服务或计划任务。
- 不修改飞书 Aily 后台配置。
- 不新增 Cloudflare Tunnel、反向代理或自定义域名证书。
- 不改变工具授权、文件访问或 consent 的业务语义。
