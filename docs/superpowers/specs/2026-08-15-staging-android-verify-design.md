# 通用 Android 自动化验证工作流设计

## 目标

构建长期复用的 `staging_android_verify` MCP 工作流：核心能力与具体 Android 应用
解耦，通过稳定契约、拓扑状态机和可插拔 Profile 自动完成已启动的
`emulator-5554` 上的 APK 安装、SSH 隧道、UI/API 验证、断线恢复和证据生成。
ZeroXCore 只是第一个 Profile，不得进入核心模块的业务分支。

## 架构原则

- **契约优先**：核心模块只依赖接口和版本化数据结构，不依赖具体包名、页面文字、
  API 路径或项目目录。
- **横向切片**：每个能力从输入契约、执行节点、状态事件、错误模型到证据输出
  完整贯通；SSH、ADB、Profile、持久化和报告互不直接耦合。
- **拓扑编排**：工作流是节点图，不是一个包含所有应用分支的巨型函数；节点通过
  明确的输入/输出契约连接，可插入、替换和重试。
- **Profile 优先、插件兜底**：常见动作使用声明式 Profile；只有配置无法表达的
  复杂逻辑才加载受限插件。
- **安全边界**：插件和 Profile 不能执行任意 shell、修改 Git、读取密钥或绕过
  目录/设备/端口约束。

## 分层拓扑

```text
MCP Adapter
    ↓ RunRequest/RunResult contract
Workflow Coordinator
    ↓ WorkflowNode contract + StateEvent
Preflight ─ Tunnel ─ Android ─ App Profile ─ Evidence
    ↓                    ↓             ↓
StateStore          DeviceAdapter   ProfileRegistry
```

核心拓扑节点：

```text
created → preflight_passed → tunnel_connected → app_ready
  → scenario_started → scenario_passed
  → tunnel_interrupted → failure_state_confirmed
  → tunnel_reconnected → recovery_passed → evidence_written → completed
```

失败、取消和清理失败是终端分支，不允许跳过前置契约直接进入后续节点。

## 契约与接口

### 运行请求

```ts
interface RunRequest {
  profileId: string;
  workdir: string;
  apkPath: string;
  deviceId?: "emulator-5554";
  sshHost: string;
}
```

`profileId` 选择应用 Profile；端口、包名、允许的动作和节点图来自已注册 Profile，
调用方不能覆盖这些安全约束。

### 平台接口

```ts
interface TunnelAdapter {
  connect(spec: TunnelSpec): Promise<TunnelHandle>;
  disconnect(handle: TunnelHandle): Promise<void>;
  probe(handle: TunnelHandle): Promise<boolean>;
}

interface AndroidDeviceAdapter {
  preflight(deviceId: string): Promise<DeviceInfo>;
  install(apk: ApkArtifact): Promise<void>;
  launch(packageName: string, activity?: string): Promise<void>;
  tap(target: UiTarget): Promise<void>;
  input(value: string): Promise<void>;
  assert(assertion: UiAssertion): Promise<void>;
  screenshot(): Promise<RedactedArtifact>;
  logcatTail(): Promise<string>;
}
```

核心只依赖接口；Windows OpenSSH、ADB 和未来的其他设备实现均为适配器。

### Profile 契约

```ts
interface AndroidAppProfile {
  id: string;
  version: number;
  packageName: string;
  activity?: string;
  tunnel: { remotePort: 3100; localPort: 3100 };
  graph: WorkflowGraph;
  capabilities: ReadonlySet<"ui" | "http" | "offline" | "recovery">;
  validate(input: ProfileInput): void;
}
```

Profile 的节点只能使用注册过的动作类型：`install_apk`、`launch_app`、`tap`、
`input`、`wait`、`assert_text`、`assert_http`、`disconnect_tunnel`、
`reconnect_tunnel` 和 `write_evidence`。复杂应用可以实现 `ProfilePlugin`，但插件
只能通过 `WorkflowContext` 访问上述适配器接口，不能取得原始子进程或环境变量。

## 应用扩展方式

### 配置 Profile（默认）

ZeroXCore 的第一份 Profile 只描述包名、端口、启动页面、UI 定位器和验证节点图。
新增普通 App 只添加新 Profile，不改核心协调器。

### 受限插件（特殊情况）

当应用需要动态签名、复杂绑定码解析或非线性流程时，Profile 可引用一个版本化
插件。插件必须实现 `ProfilePlugin`，通过能力声明申请 `ui/http/offline/recovery`
权限，并接受超时、取消和输出大小限制。

## 安全与资源边界

- 首版只接受已连接的 `emulator-5554`，不自动启动 AVD。
- SSH 只使用 Windows `~/.ssh/config` alias，固定转发 staging loopback 端口。
- APK 安装前验证文件、包名和 SHA-256。
- Profile 不能传任意 shell、SSH 参数、设备序列号或 Git 写操作。
- 每个节点有超时、取消信号和最大输出；每个子进程记录归属 `runId`。
- 绑定码、Token、PIN、Cookie、私钥和完整认证响应只可进入内存，日志和证据必须脱敏。
- 运行结束清理自身 SSH、临时 ADB reverse 和临时文件；不触碰外部进程。

## 证据与状态

每次运行生成 `runId`，StateStore 原子保存节点状态、Profile 版本、commit、设备和
APK 摘要。EvidenceWriter 只写脱敏 Markdown/JSON，记录节点结果、时间、错误摘要和
截图引用。重复请求按 `runId` 从最近安全检查点恢复，终端状态不可再次执行副作用。

## 错误模型

统一错误契约包含 `code`、`nodeId`、`retryable`、`redactedMessage` 和 `cleanupState`。
SSH 断开只有在拓扑声明的 `tunnel_interrupted` 节点中视为预期分支；ADB 设备变化、
包名不符、Profile 版本不兼容、未声明动作和清理失败均立即终止。

## 测试策略

- 契约测试：验证 Profile、节点图、适配器和运行结果的版本与字段兼容性。
- 拓扑测试：验证合法迁移、非法跳转、重试、恢复、取消和幂等。
- 适配器合同测试：用 fake SSH/ADB 实现验证相同接口行为，不启动真实进程。
- Profile 测试：ZeroXCore Profile 只测试自己的节点图和断线判定；另加一个最小
  dummy Profile，证明核心不依赖 ZeroXCore。
- 真实验收：仅在 `emulator-5554` 和 SSH alias 存在时运行；不得自动提交或推送。

## 非目标

- 自动启动或管理 AVD；
- 支持实体 Android 手机（由未来 DeviceAdapter 扩展）；
- 将任意 shell 暴露给 Profile 或插件；
- 生产切换、数据库迁移、Nginx/DNS 修改；
- 自动 Git commit/push。
