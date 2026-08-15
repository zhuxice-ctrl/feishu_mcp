# Android Staging 验证工作流设计

## 目标

新增一个可恢复的 `staging_android_verify` MCP 工作流，用于在本机已启动的
`emulator-5554` 上完成 ZeroXCore staging 验收：通过 Windows SSH config 别名建立
loopback 隧道，安装并校验 Debug APK，配置 ADB reverse，自动执行 Android 绑定与
`enroll/challenge/verify` 验证，主动中断隧道确认失败提示，恢复隧道后再次验证，并
生成脱敏验收记录。

首版不负责启动 Android Emulator，不接受私钥或密码输入，不执行 `git commit` 或
`git push`。

## 范围与约束

- 设备仅支持已连接且状态为 `device` 的 `emulator-5554`。
- SSH 仅使用 Windows `~/.ssh/config` 中的 alias；目标只允许 staging 的
  `127.0.0.1:3100`。
- APK 安装前校验文件存在、包名和 SHA-256。
- 所有 SSH、ADB 和子进程由工作流创建并记录；只清理自身创建的进程。
- 绑定码、Token、PIN、私钥和完整认证响应不得写入日志或证据文件。
- MCP 调用方不能传入任意 shell 命令、任意 SSH 参数或任意设备序列号。
- 运行结束必须清理 SSH 隧道、临时 ADB 状态和工作目录中的临时文件。

## 架构

### Preflight

检查 SSH alias、`emulator-5554`、ADB 状态、APK、包名、commit、端口和必要工具。
任何检查失败都在产生外部副作用前终止。

### TunnelManager

使用固定参数建立 SSH local forward，记录 PID、启动时间和目标端口。通过进程状态
与本地端口探测判断连接是否有效；断开时进入可恢复状态。停止时只终止由当前
`runId` 创建的 SSH 进程。

### AndroidDriver

负责 APK 安装、`adb reverse tcp:3100 tcp:3100`、应用启动、ADB 点击/输入、截图和
logcat 采集。每次操作验证设备仍为 `emulator-5554`，设备变化或离线立即失败并
进入清理流程。

### VerificationRunner

按固定步骤完成绑定与恢复验证，不接受调用方提供的任意请求路径或任意命令：

1. 隧道建立后启动 App 并完成首次绑定；
2. 调用 `enroll/challenge/verify`，记录状态码和安全摘要；
3. 中断 SSH，确认 App 显示预期网络失败状态；
4. 恢复 SSH，重新执行完整绑定链路；
5. 验证最终状态为成功。

### EvidenceWriter

为每次运行生成 `runId`，记录完整 commit、APK SHA-256、设备 ID、步骤状态、时间和
脱敏错误摘要，写入 `docs/deployment/evidence/staging-<runId>.md`。证据文件不得包含
认证凭据、绑定码、Cookie、私钥或完整 HTTP 响应。

## 状态机

```text
created
  -> preflight_passed
  -> tunnel_connected
  -> apk_installed
  -> app_ready
  -> binding_verified
  -> tunnel_interrupted
  -> failure_state_confirmed
  -> tunnel_reconnected
  -> recovery_verified
  -> completed
```

任何步骤失败进入 `failed`，并记录清理结果。重复提交同一 `runId` 从最近安全检查点
恢复，不重复执行已完成的破坏性步骤。取消操作进入 `cancelled`，随后执行同样的
清理流程。

## MCP 接口

工具名：`staging_android_verify`

```json
{
  "sshHost": "staging",
  "workdir": "F:\\zeroxcore",
  "apkPath": "app/build/outputs/apk/debug/app-debug.apk",
  "packageName": "tech.zeroxcore.app",
  "deviceId": "emulator-5554",
  "remotePort": 3100,
  "localPort": 3100
}
```

`deviceId`、`remotePort` 和允许的本地端口范围由服务端约束；调用方不能覆盖 SSH
参数、私钥路径、shell 命令或 Git 写操作。

结构化输出包含 `runId`、最终状态、commit、APK SHA-256、设备信息、各步骤状态和
证据文件路径。长任务应返回可轮询的运行 ID，并提供内部的状态读取、恢复和取消
能力，而不是让 MCP 请求长期阻塞。

## 错误处理与恢复

- SSH alias 不存在、认证失败或目标端口不可达：在 preflight/tunnel 阶段失败。
- ADB 无设备、设备序列号变化或安装失败：停止后续步骤并清理隧道。
- App 未启动、绑定码输入失败或响应格式异常：保存脱敏截图/logcat 摘要并失败。
- SSH 中断：只允许进入预期的 `tunnel_interrupted` 分支；其他网络错误失败。
- 清理失败：最终状态标记为 `failed_cleanup`，报告残留 PID/端口，但不终止外部
  非本运行进程。
- 所有超时、重试次数和输出大小均受现有 MCP 全局限制约束。

## 测试策略

### 单元测试

覆盖状态迁移、幂等恢复、SSH 参数构造、设备校验、端口约束、APK 哈希校验、敏感
字段脱敏和清理逻辑。

### 集成测试

使用假的 SSH、ADB、HTTP 和文件系统适配器验证成功、超时、断开、重连、取消、
重复运行和清理失败路径；测试不得启动真实隧道或修改用户模拟器。

### 真实环境验收

仅在发现 `emulator-5554` 且 SSH alias 可用时运行；否则只执行 preflight。成功标准
是首次绑定、断线失败提示、恢复绑定和证据文件全部通过，且 Git 工作树没有被工具
自动提交或推送。

## 非目标

- 自动创建或启动 AVD；
- 支持实体 Android 手机；
- 任意远程 shell 执行；
- 生产环境切换、数据库变更、Nginx/DNS 修改；
- 自动提交或推送 Git。
