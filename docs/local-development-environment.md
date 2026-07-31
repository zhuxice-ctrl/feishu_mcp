# 本地开发环境自动化使用指南

本指南详细说明 feishu_mcp 的 9 个开发环境工具（owner 专用）的自然语言使用方式和参数级调试方法。

所有开发工具仅对配置的 owner（所有者）身份可见。非 owner 调用会返回 `OWNER_REQUIRED`，不会降级为普通工具。长操作返回 task ID，客户端可在同一会话中查询进度、读取日志或请求取消。

## 前置条件

- MCP 服务已构建（`npm run build`），`/health` 返回 `toolCount: 30`
- `AUTH_MODE=pin` 或 `header`，owner 身份已通过 `auth` 工具认证
- Windows 部署已安装管理员代理（见下文"管理员代理"）
- Android 开发需本地安装 Android SDK 和 JDK
- Windows 开发需本地安装 .NET 8 SDK / Visual Studio / CMake

## 管理员代理

管理员代理（Admin Broker）是一个本地 Windows 服务，以 SYSTEM 权限运行，接收 MCP 服务器通过命名管道发送的特权操作请求。MCP 服务器自身不以管理员身份运行。

安装：

```text
install-feishu-mcp-admin-broker.bat
```

卸载：

```text
uninstall-feishu-mcp-admin-broker.bat
```

安装脚本会生成 32 字节共享密钥并设置 ACL，仅允许 owner SID 和 SYSTEM 访问。密钥路径通过 `DEV_ENV_BROKER_KEY_PATH` 配置。MCP 服务器通过 HMAC 签名验证每个请求。

代理状态在 `/health` 中报告为 `ready`、`missing` 或 `incompatible`。`missing` 表示代理未安装；`incompatible` 表示协议版本不匹配，需要重新安装。

## 工具总览

| 工具 | 功能 | 操作类型 |
|------|------|----------|
| `get_development_task` | 查询后台任务状态 | 同步·读 |
| `read_development_task_logs` | 读取任务日志（支持分页游标） | 同步·读 |
| `cancel_development_task` | 请求取消运行中的任务 | 同步·写 |
| `inspect_development_environment` | 检查已安装的工具链组件 | 同步·读 |
| `plan_environment_changes` | 生成签名单次环境变更计划 | 同步·写 |
| `apply_environment_plan` | 执行已签名的环境计划 | 审批·写 |
| `android_development` | Android 构建/测试/设备/签名操作 | 混合 |
| `windows_development` | Windows .NET/原生/Electron 操作 | 混合 |
| `manage_development_project` | 项目模板列表/检查/创建 | 混合 |

## 自然语言示例

### 检查开发环境

```
检查一下我的开发环境，看看安装了哪些工具链
```

AI 会调用 `inspect_development_environment`，返回已安装的 Android SDK、JDK、.NET SDK、MSBuild、CMake、Ninja 等组件版本和路径。只读操作，不需要审批。

### 安装环境组件

```
帮我安装 Android SDK Platform 34
```

AI 会先调用 `plan_environment_changes` 生成签名计划，展示要安装的组件和目标路径。你确认后，AI 调用 `apply_environment_plan` 执行安装。安装操作通过管理员代理执行，需要代理已安装（`brokerState: ready`）。

### 创建 Android 项目

```
在 F:\Projects 下创建一个空的 Kotlin Android 项目，包名 com.example.myapp
```

AI 调用 `manage_development_project`（action: `create`），展示 ecosystem、template、destination 等标识。你确认后，AI 在指定目录下原子性地暂存并提交项目文件。如果创建失败，所有已写入的文件会回滚。

### 构建 Android APK

```
构建 F:\Projects\MyApp 的 debug APK
```

AI 调用 `android_development`（action: `build`），返回 task ID。构建在后台运行，你可以继续对话。

### 查询构建进度

```
构建完成了吗？
```

AI 调用 `get_development_task` 查询任务状态。如果任务还在运行，返回当前状态和进度。如果已完成，返回结果和产物路径。

### 查看构建日志

```
看一下构建日志的最后 50 行
```

AI 调用 `read_development_task_logs`，使用游标参数读取日志尾部。

### 取消构建

```
取消这个构建任务
```

AI 调用 `cancel_development_task`，请求优雅取消。任务会在宽限期后终止。

### 设备操作

```
在我的模拟器上安装 debug APK 并启动应用
```

AI 依次调用 `android_development`（action: `install`）和 `android_development`（action: `start_app`），需要指定设备序列号。设备写操作需要单次审批。

### Windows .NET 构建

```
构建 F:\Projects\MyApp 的 .NET 项目，配置 Release
```

AI 调用 `windows_development`（action: `build`），指定项目路径、配置和目标框架。.NET 构建在后台运行并返回 task ID。

### Windows 原生构建

```
用 CMake 构建 F:\Projects\NativeLib，生成器 Ninja
```

AI 调用 `windows_development`（action: `build`），platform 为 `native`，指定 CMake 变量和生成器。

### Electron 打包

```
打包 F:\Projects\ElectronApp 的 Windows 版本
```

AI 调用 `windows_development`（action: `build`），platform 为 `electron`。

### 签名验证

```
验证 F:\Projects\MyApp\app-release.apk 的签名
```

AI 调用 `android_development`（action: `verify`），检查 APK 签名方案和证书指纹。只读操作。

## 参数级调试

### 任务查询参数

```json
{
  "action": "get",
  "taskId": "550e8400-e29b-41d4-a716-446655440000"
}
```

返回 `state`（queued / running / succeeded / failed / cancelled / interrupted）、`exitCode`、`artifacts`、`byteSize`、时间戳。

### 日志读取参数

```json
{
  "taskId": "550e8400-e29b-41d4-a716-446655440000",
  "cursor": "eyJvZmZzZXQiOjB9",
  "limit": 100
}
```

`cursor` 为空时从头开始。返回 `lines`、`nextCursor`、`totalBytes`。

### Android 构建参数

```json
{
  "action": "build",
  "projectPath": "F:\\Projects\\MyApp",
  "variant": "debug",
  "modules": ["app"],
  "tasks": ["assembleDebug"]
}
```

### Android 设备操作参数

```json
{
  "action": "install",
  "serial": "emulator-5554",
  "apkPath": "F:\\Projects\\MyApp\\app\\build\\outputs\\apk\\debug\\app-debug.apk"
}
```

设备序列号必须是精确的 `emulator-XXXX` 或 `USB_SERIAL`，不支持通配符或关键字。

### Windows 构建参数

```json
{
  "action": "build",
  "projectPath": "F:\\Projects\\MyApp",
  "platform": "dotnet",
  "configuration": "Release",
  "targetFramework": "net8.0"
}
```

### 项目创建参数

```json
{
  "action": "create",
  "ecosystem": "android",
  "template": "kotlin-empty",
  "destination": "F:\\Projects\\MyApp",
  "packageName": "com.example.myapp"
}
```

创建操作需要单次审批，展示 ecosystem、template、destination 等公开标识。暂存失败时自动回滚。

## 审批流程

需要审批的操作遵循统一的单次审批协议：

1. AI 调用工具，MCP 返回 `input_required` 和签名请求状态
2. AI 在飞书对话中展示操作标识（不含密钥、路径细节或参数值）
3. 用户确认后，AI 用相同参数重试，MCP 验证签名状态后执行
4. 执行后状态立即标记为已使用，相同参数的重试会被拒绝
5. 不支持 `input_required` 的客户端始终被拒绝，不会降级为终端输入

审批状态存储在 `APPROVAL_DATA_DIR` 内，签名密钥为 32 字节随机值，由 `APPROVAL_STATE_SECRET` 配置或本地密钥文件生成。

## 后台任务管理

### 任务数据

任务元数据和日志存储在 `DEV_TASK_DATA_DIR`（默认为 `<APPROVAL_DATA_DIR>/tasks`）。任务数据按 owner 隔离，仅 owner 可访问自己的任务。

### 任务管理脚本

```text
manage-development-tasks.bat -List
manage-development-tasks.bat -Remove 550e8400
manage-development-tasks.bat -ClearTerminal
```

`-List` 显示脱敏摘要（ID 前缀、工具名、操作、状态、时间戳、字节大小）。`-Remove` 仅删除终端状态任务（succeeded / failed / cancelled / interrupted）。`-ClearTerminal` 清除所有终端状态任务。

### 并发与保留

- 最多 4 个并发任务（`DEV_MAX_TASKS`），其中最多 2 个构建任务（`DEV_MAX_BUILDS`）
- 任务数据保留 14 天（`DEV_TASK_RETENTION_DAYS`）
- 单任务最大运行时间 2 小时（`DEV_TASK_MAX_RUNTIME_MS`）
- 单日志文件最大 50 MB（`DEV_TASK_LOG_MAX_BYTES`）
- 总任务数据最大 1 GB（`DEV_TASK_MAX_TOTAL_BYTES`）

### 任务恢复

MCP 服务重启后，正在运行的任务会标记为 `interrupted`。日志和产物保留在磁盘上，可通过 `get_development_task` 和 `read_development_task_logs` 查看。不会自动重启中断的任务。

## 凭据管理

开发签名凭据通过 `manage-development-credentials.bat` 管理：

```text
manage-development-credentials.bat -List
manage-development-credentials.bat -Add Android
manage-development-credentials.bat -Add Windows
manage-development-credentials.bat -Remove Android
```

Android 密码凭据以 DPAPI 加密 blob 保存在 `APPROVAL_DATA_DIR\credentials`。Windows 签名先将代码签名证书及私钥安装到当前用户的 `CurrentUser\My` 证书库，再用 `create`、`Kind=certificate`、公开 SHA-1 指纹登记 UUID；运行时不会导入 PFX，也不会把私钥、PFX 密码、辅助脚本或可执行文件路径写入 MCP 参数、任务元数据或日志。

Android 签名：

```json
{
  "action": "sign",
  "apkPath": "F:\\Projects\\MyApp\\app-release-unsigned.apk",
  "credentialAlias": "android-debug"
}
```

Windows 签名：

```json
{
  "action": "sign",
  "artifactPath": "F:\\Build\\MyApp.dll",
  "credentialAlias": "windows-test"
}
```

Windows 签名会复制到同目录暂存文件，依次执行固定的 SignTool 签名和验证，验证成功后才由任务 worker 原子发布；失败、取消或超时会保留原输出并删除暂存文件。

## 失败处理

- **BROKER_UNAVAILABLE**：管理员代理未安装或不兼容。运行 `install-feishu-mcp-admin-broker.bat` 安装。
- **OWNER_REQUIRED**：当前身份不是配置的 owner。检查 `OWNER_USER_ID` 和请求头 `x-aily-user`。
- **APPROVAL_EXPIRED**：审批状态已过期（默认 10 分钟）。重新发起操作。
- **APPROVAL_ALREADY_USED**：单次审批已消费。重新发起操作。
- **TASK_NOT_FOUND**：任务 ID 不存在或已过期清理。检查任务列表。
- **TOOLCHAIN_NOT_READY**：所需工具链组件未安装。先调用 `inspect_development_environment` 检查。
- **DESTINATION_EXISTS**：项目创建目标目录已存在且非空。选择新的目标路径。

## 排除范围

以下操作不在支持范围内：

- GUI 自动化（鼠标、键盘、屏幕截图驱动）
- Godot / Photoshop 等第三方图形工具
- 任意 shell 命令执行（使用 `execute_command` 工具，不属于开发工具）
- Android root / bootloader 解锁
- 以管理员身份运行 MCP 服务器
- 永久授权开发操作（所有写操作均为单次审批）

## 实际验收

运行只读验收检查：

```text
test-real-development-environment.bat -Mode Inspect
```

运行完整 Android + Windows 验收（需要真实环境）：

```text
test-real-development-environment.bat -Mode All -Root F:\FeishuMcpAcceptance -ConfirmRealChanges
```

验收检查清单见 [development-acceptance-checklist.md](development-acceptance-checklist.md)。
