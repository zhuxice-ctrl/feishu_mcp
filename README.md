# aily-local-file-mcp

Feishu Aily 本地文件 MCP 服务 — 通过 Streamable HTTP 传输为飞书 Aily 提供安全的文件系统工具。

## 当前阶段

**Phase 1: 项目初始化与 HTTP MCP Server 骨架** — 已完成

- TypeScript + MCP SDK v2 (`@modelcontextprotocol/server` 2.0.0-beta)
- Express + Streamable HTTP 传输
- DNS rebinding 防护 + Origin 验证（内置中间件）
- `ping` 工具（健康检查）
- `/health` 端点（非 MCP）

## 技术栈

| 组件 | 版本 | 说明 |
|------|------|------|
| Node.js | ≥ 22 | ESM 运行时 |
| TypeScript | 5.7+ | 类型安全 |
| `@modelcontextprotocol/server` | 2.0.0-beta.5 | MCP 服务端 SDK v2 |
| `@modelcontextprotocol/express` | 2.0.0-beta.5 | Express 集成 |
| Express | 4.x | HTTP 框架 |
| Zod | 4.x | Schema 验证 |

## 快速开始

```bash
# 安装依赖
npm install

# 开发模式（热重载）
npm run dev

# 编译
npm run build

# 生产运行
npm start
```

服务默认监听 `http://0.0.0.0:3000`。

## 端点

| 路径 | 方法 | 说明 |
|------|------|------|
| `/mcp` | POST / GET / DELETE | MCP Streamable HTTP 端点 |
| `/health` | GET | 健康检查 |

## 配置

通过环境变量配置（参考 `.env.example`）：

```bash
PORT=3000              # 监听端口
HOST=0.0.0.0           # 监听地址
MCP_ENDPOINT=/mcp      # MCP 端点路径
```

## 开发路线

- [x] **Phase 1**: 项目初始化 + HTTP MCP Server 骨架
- [ ] **Phase 2**: 文件读写工具实现（read_file / write_file / edit_file / list_directory 等）
- [ ] **Phase 3**: 安全层加固（路径穿越防护、文件类型黑名单、并发控制、频率限制）
- [ ] **Phase 4**: Cloudflare Tunnel 部署
- [ ] **Phase 5**: 飞书 Aily 接入与端到端测试

## License

MIT
