# 手动 Cloudflare Tunnel 恢复说明

## 设计核心

`cf_mcp` 仍由用户手动启动；启动期间 supervisor 只监控并恢复生产 Tunnel，不会注册 Windows 服务、不开机自启，也不会重启本地 MCP。

## 启动与停止

在仓库目录执行：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\start-cf-mcp.ps1
```

停止本次手动会话：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\stop-cf-mcp.ps1
```

查看当前生产会话状态：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\tunnel-supervisor.ps1 -Action Status
```

运行状态文件只保存到 `%LOCALAPPDATA%\FeishuMcp\tunnel\production-state.json`，只包含进程 ID、时间、重启次数和状态，不包含 token、授权头或凭据内容。

## 健康判断

验证脚本同时检查本地 MCP、cloudflared metrics 活动 HA connector、公网健康和命名 Tunnel 活动连接：

```powershell
.\scripts\test-cloudflare-tunnel.ps1 -PublicHost mcp.zxc66.asia -Port 3000 -MetricsPort 20241 -TunnelName feishu-mcp
```

supervisor 连续三次发现 connector 或公网不健康时，只替换匹配生产配置的 cloudflared 进程；本地 Node MCP 不会被重启。单次会话最多恢复四次，超过后报告 `manual_action_required`，需要重新运行启动脚本。

## Mihomo fake-IP 例外

在 Clash Verge 的 DNS 配置 `fake-ip-filter` 中保留以下两条：

```yaml
- '+.argotunnel.com'
- '+.cfargotunnel.com'
```

这两条只针对 Cloudflare Tunnel 传输域名，避免长期连接被 fake-IP 映射；不会修改通用代理规则、节点、订阅或测试 Tunnel。配置变更前应创建时间戳备份；若重载后网络异常，恢复最近的 `dns_config.backup-*.yaml`，再通过 Clash Verge 正常重载。

## 明确不会发生的事情

- 不安装或启动 `cloudflared` Windows 服务。
- 不创建计划任务或开机启动项。
- 不共享生产与测试 Tunnel 的配置、凭据、状态文件。
- 不把 `.cloudflared` 下的 credential JSON、MCP token 或代理配置提交到 Git。
