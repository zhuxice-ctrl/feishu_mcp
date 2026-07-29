# 飞书 Aily MCP 接入指南

本指南将 feishu_mcp 服务接入飞书 Aily 平台，实现通过 AI 助手远程读写本地文件。

## 前置条件

- [ ] MCP 服务已构建完成（`npm run build`），`/health` 返回正常
- [ ] 已选择工具授权模式；默认 `pin` 模式已设置 `AUTH_PIN`（至少 8 个字符）
- [ ] ngrok 已安装并配置了固定域名（见 README 中的 ngrok 设置步骤）
- [ ] 拥有飞书 Aily 管理后台权限

## 接入步骤

### 1. 验证公网连通性

确保 ngrok 隧道已启动，公网地址可访问：

```bash
# 测试健康检查端点
curl https://your-domain.ngrok-free.app/health

# 测试 MCP 端点（需要 Token）
curl -X POST https://your-domain.ngrok-free.app/mcp \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"test","version":"1.0"}}}'
```

如果返回 SSE 格式的 `initialize` 响应，说明公网链路正常。

### 2. 在飞书 Aily 中创建企业自定义 MCP

1. 打开飞书 Aily 管理后台
2. 进入 **MCP 管理** → **添加 MCP**
3. 选择 **企业自定义 MCP**
4. 填写基本信息：

| 字段 | 值 |
|------|------|
| 名称 | 本地文件助手 |
| 描述 | 完整本地开发环境，支持文件、命令、搜索、Git、补丁、网页和对话确认 |
| 图标 | 选择一个文件夹图标 |
| 介绍 | 提供 21 个本地开发工具，内置路径防护、命令风险分类、飞书窗口内确认、有界并发、事务回滚与审计。 |

### 3. 配置请求地址

| 字段 | 值 |
|------|------|
| 请求地址 | `https://your-domain.ngrok-free.app/mcp` |
| Endpoint 类型 | **Streamable HTTP** |

### 4. 配置传输层 Bearer Token

添加一个请求参数用于传递 Bearer Token：

| 字段 | 值 |
|------|------|
| 参数名 | `Authorization` |
| 参数位置 | **Header** |
| 参数值 | `Bearer YOUR_MCP_AUTH_TOKEN` |
| 传值方式 | **用户输入** |

> 使用「用户输入」方式让每个使用者自行填入 Token，Token 不会硬编码在服务端配置中。

Bearer Token 只保护 HTTP/ngrok 入口；工具调用还受 `AUTH_MODE` 控制：

- `pin`（默认）：平台需在每个请求中提供稳定的 `x-aily-user`，然后调用 `auth` 工具并传入服务端配置的 PIN。
- `none`：关闭工具级授权，仅使用 Bearer Token，适合个人单用户部署。
- `header`：信任身份头，仅可放在可信网关后。网关必须删除客户端自带的身份头并重新注入；不要直接通过 ngrok 暴露 header 模式。

PIN 不会输出到 stdout、stderr 或日志。请通过安全渠道把它交给需要认证的操作者，不要写入普通对话或公开配置。

### 5. 配置仅所有者可见的企业内部目录

若该企业内部 MCP 应只让设备所有者使用，请在服务部署中配置以下值（不包含
Token、PIN 或其他密钥）：

```env
ALLOWED_DIRS=
OWNER_USER_ID=owner
OWNER_DEFAULT_DIRS=F:\
```

同时在 Aily 为该 MCP 固定配置 `x-aily-user=owner` 请求头，并仅让所有者看见该
MCP 工具。该固定身份是 `F:\` 默认目录只对 owner 生效的前提；其他用户不能共享
或继承此范围。目录授权不会新增工具，`tools/list` 始终保持 21 个工具。

当工具首次访问范围外目录时，飞书会显示“本次允许”、“当前服务进程内允许”、
“永久允许”和“拒绝”四个选择。批准后服务会自动重试原始调用；拒绝则不产生文件
系统副作用。唯一不可授权的内部数据范围是 MCP 的授权数据目录、审批数据库、
签名密钥及其子路径。

查看或撤销本机的永久目录授权：

```text
manage-feishu-mcp-approvals.bat -ListDirectories
manage-feishu-mcp-approvals.bat -RemoveDirectory <编号或ID前缀>
manage-feishu-mcp-approvals.bat -ClearDirectories
```

输出使用编号、ID 前缀、不可逆用户哈希和目录名/卷标，绝不显示完整路径或原始用户
身份。

### 6. 在 Aily 中添加并测试 MCP

1. 在 Aily 助手对话中，添加该 MCP
2. 输入你的 Bearer Token
3. 若使用 `pin` 模式，先让当前身份调用 `auth` 工具
4. 测试工具调用：

```
# 测试 ping
请使用本地文件助手的 ping 工具，消息写"hello"

# 列出允许的目录
请列出本地文件助手可以访问的目录

# 读取文件
请读取 /path/to/workspace/test.txt 文件

# 列出目录
请列出 /path/to/workspace 目录的内容

# 搜索代码并查看 Git 差异
请搜索工作区中包含 TODO 的代码，再查看 git status 和未暂存 diff

# 高风险操作会弹出飞书补充信息卡片
请在工作区运行 npm test；需要授权时让我在当前窗口确认
```

需要授权时，飞书客户端应显示四个选择：本次允许、当前服务进程内允许、永久允许、拒绝。客户端若不支持 MCP `input_required`，服务会拒绝受保护操作，不会退回终端、浏览器或普通文本确认。永久许可按用户、工具和精确目标保存，可在服务所在电脑运行 `manage-feishu-mcp-approvals.bat` 查看或撤销。

### 7. 端到端验证清单

- [ ] `ping` 工具返回 `pong`
- [ ] `list_allowed_directories` 返回配置的目录
- [ ] `read_file` 成功读取文本文件
- [ ] `write_file` 成功写入文件
- [ ] `list_directory` 返回目录列表
- [ ] `search_files` 返回搜索结果
- [ ] `get_file_info` 返回文件元数据
- [ ] `create_directory` 成功创建目录
- [ ] `move_file` 成功移动文件
- [ ] `edit_file` 成功编辑文件
- [ ] `execute_command` 对明确只读命令直接执行，对高风险命令返回确认卡片
- [ ] `search_content` 返回带文件和行号的匹配
- [ ] `git_status` / `git_diff` 不启动外部 pager 或 diff helper
- [ ] `compare_files` 返回 unified diff
- [ ] `apply_patch` 成功写入，失败时保持原文件
- [ ] `web_fetch` 首次访问来源域时要求确认
- [ ] `todo_write` / `todo_read` 按用户隔离
- [ ] `ask_user` 在飞书对话内返回文本或选项结果

### 8. 安全验证清单

- [ ] 未提供 Token 时请求被拒绝（401）
- [ ] 提供错误 Token 时请求被拒绝（401）
- [ ] 尝试读取白名单外的文件被拒绝
- [ ] 尝试路径穿越（`../../../etc/passwd`）被拒绝
- [ ] `.env` 等敏感文件按 `CONSENT_SENSITIVE_FILE` 策略被允许、确认或拒绝
- [ ] 未认证身份不能调用 `auth` 之外的工具（`pin` 模式）
- [ ] 不支持窗口内确认的客户端被拒绝，且不会触发终端输入
- [ ] 永久授权可在本机管理脚本中撤销，授权存储目录不能通过 MCP 读取
- [ ] `/health` 只显示授权数量和并发水位，不显示用户、路径、命令、URL 或密钥
- [ ] 尝试写入 `.exe` 等危险文件类型被拒绝
- [ ] 操作日志中记录了所有写操作
- [ ] 软删除的文件出现在 `.trash` 目录中

## 故障排查

### ngrok 隧道问题

- **隧道无法启动**：检查 `ngrok config add-authtoken` 是否已执行
- **域名不对**：ngrok 3 使用 `--url=https://你的固定域名`，确认 `.env` 中的 `NGROK_DOMAIN` 与控制台域名一致
- **连接被拒绝**：确认本地 MCP 服务正在运行（`curl http://localhost:3000/health`）
- **ngrok 免费版限制**：有连接数和带宽限制，个人使用足够

### MCP 初始化失败

- 检查 ngrok 隧道是否正常运行
- 检查本地 MCP 服务是否运行：`curl http://localhost:3000/health`
- 检查 Token 是否正确：在 Aily 中重新输入 Token

### 工具调用返回错误

- 查看操作日志：`logs/mcp-operations.log`
- 检查路径是否在 `ALLOWED_DIRS` 白名单内
- 检查文件类型是否在黑名单中
- 检查是否触发频率限制（默认 60 次/分钟）
