# 飞书 Aily MCP 接入指南

本指南将 aily-local-file-mcp 服务接入飞书 Aily 平台，实现通过 AI 助手远程读写本地文件。

## 前置条件

- [ ] Phase 1-3 完成：MCP 服务已编译，`/health` 返回正常
- [ ] Phase 4 完成：Cloudflare Tunnel 已配置，公网域名可访问
- [ ] 拥有飞书 Aily 管理后台权限

## 接入步骤

### 1. 验证公网连通性

确保 Cloudflare Tunnel 已启动，公网地址可访问：

```bash
# 测试健康检查端点
curl https://aily-mcp.yourdomain.com/health

# 测试 MCP 端点（需要 Token）
curl -X POST https://aily-mcp.yourdomain.com/mcp \
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
| 描述 | 远程读写本地文件系统，支持文件读写、目录管理、搜索等操作 |
| 图标 | 选择一个文件夹图标 |
| 介绍 | 支持 9 种文件操作工具，内置路径穿越防护、文件类型黑名单、软删除回收站等安全机制。需配置 Token 鉴权。 |

### 3. 配置请求地址

| 字段 | 值 |
|------|------|
| 请求地址 | `https://aily-mcp.yourdomain.com/mcp` |
| Endpoint 类型 | **Streamable HTTP** |

### 4. 配置请求参数（鉴权 Token）

添加一个请求参数用于传递 Bearer Token：

| 字段 | 值 |
|------|------|
| 参数名 | `Authorization` |
| 参数位置 | **Header** |
| 参数值 | `Bearer YOUR_MCP_AUTH_TOKEN` |
| 传值方式 | **用户输入** |

> 使用「用户输入」方式让每个使用者自行填入 Token，Token 不会硬编码在服务端配置中。

### 5. 在 Aily 中添加并测试 MCP

1. 在 Aily 助手对话中，添加该 MCP
2. 输入你的 Bearer Token
3. 测试工具调用：

```
# 测试 ping
请使用本地文件助手的 ping 工具，消息写"hello"

# 列出允许的目录
请列出本地文件助手可以访问的目录

# 读取文件
请读取 /tmp/mcp-test-workspace/test.txt 文件

# 列出目录
请列出 /tmp/mcp-test-workspace 目录的内容
```

### 6. 端到端验证清单

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

### 7. 安全验证清单

- [ ] 未提供 Token 时请求被拒绝（401）
- [ ] 提供错误 Token 时请求被拒绝（401）
- [ ] 尝试读取白名单外的文件被拒绝
- [ ] 尝试路径穿越（`../../../etc/passwd`）被拒绝
- [ ] 尝试读取 `.env` 等敏感文件被拒绝
- [ ] 尝试写入 `.exe` 等危险文件类型被拒绝
- [ ] 操作日志中记录了所有写操作
- [ ] 软删除的文件出现在 `.trash` 目录中

## 故障排查

### MCP 初始化失败

- 检查 Cloudflare Tunnel 是否正常运行：`Get-Service cloudflared`（Windows）
- 检查本地 MCP 服务是否运行：`curl http://localhost:3000/health`
- 检查 Token 是否正确：在 Aily 中重新输入 Token

### 工具调用返回错误

- 查看操作日志：`logs/mcp-operations.log`
- 检查路径是否在 `ALLOWED_DIRS` 白名单内
- 检查文件类型是否在黑名单中
- 检查是否触发频率限制（默认 60 次/分钟）

### Cloudflare Tunnel 断连

- Quick Tunnel 的随机域名每次重启都会变，生产环境必须使用命名 Tunnel
- 检查 `cloudflared` 服务状态和日志
- 配置自动重连（命名 Tunnel 默认支持）
