# 会话内目录授权设计

## 1. 目标

让已认证用户在飞书对话中直接扩展本地目录访问范围，不再要求操作者编辑 `.env` 并重启服务。

当现有文件、搜索、Git、命令、比较或补丁工具访问当前范围外的路径时，原工具直接返回 MCP `input_required` 目录授权卡片。用户选择后，SDK 使用签名状态重新进入同一个工具调用；批准则继续原操作，拒绝则不产生任何文件系统副作用。

本功能不新增公开 MCP 工具，公开工具数量保持 **21**。

## 2. 已确认决策

- 部署模型为单用户，稳定身份是 `x-aily-user=owner`。
- `owner` 默认允许访问整个 `F:\`，无需逐项目授权。
- `C:\`、`D:\` 和其他路径默认未允许，但可以通过飞书会话授权。
- 目录授权提供四个选择：
  - `allow_once`：仅当前原始工具调用；
  - `allow_session`：当前 Node.js 进程生命周期；
  - `allow_permanent`：重启后继续生效；
  - `deny`：拒绝。
- 不设置 Windows、Program Files、AppData、用户主目录或盘符根目录的永久黑名单；这些目录只要卡片明确展示且用户批准即可授权。
- 唯一不可授权的范围是 MCP 自身的授权数据目录、审批数据库、签名密钥及其子路径。
- 永久授权按用户和规范化物理目录隔离；其他身份不能继承 `owner` 的默认目录或动态授权。
- 不支持 MCP `input_required` 的客户端安全拒绝，不回退终端、浏览器或普通文本确认。
- 目录授权卡片属于安全审批流程，不使用 `ask_user` 模拟授权。

## 3. 非目标

- 不让智能体修改 `.env`。
- 不为扩大目录范围重启服务。
- 不新增 `request_directory_access` 或 `manage_directories` 等公开 MCP 工具。
- 不把永久目录授权写回 `ALLOWED_DIRS`。
- 不允许未认证或缺少稳定用户身份的请求保存会话/永久目录授权。
- 不移除现有 PIN、Bearer Token、并发、文件大小、扩展名、敏感文件、网络或补丁安全策略。

## 4. 配置与兼容性

### 4.1 新配置

```env
OWNER_USER_ID=owner
OWNER_DEFAULT_DIRS=F:\
```

- `OWNER_USER_ID`：拥有设备默认目录的稳定请求身份；默认空字符串，空值表示不启用设备所有者默认目录。
- `OWNER_DEFAULT_DIRS`：逗号分隔的默认目录，只对 `OWNER_USER_ID` 生效；默认空数组。

### 4.2 现有配置

`ALLOWED_DIRS` 保持向后兼容，仍表示对所有已通过工具授权的用户生效的静态目录。有效目录集合为：

```text
effectiveRoots(userId)
  = ALLOWED_DIRS
  + (userId == OWNER_USER_ID ? OWNER_DEFAULT_DIRS : [])
  + sessionDirectoryGrants(userId)
  + permanentDirectoryGrants(userId)
```

本设备迁移后的推荐配置：

```env
ALLOWED_DIRS=
OWNER_USER_ID=owner
OWNER_DEFAULT_DIRS=F:\
```

启动器从“必须存在非空 `ALLOWED_DIRS`”改为“`ALLOWED_DIRS` 或 `OWNER_DEFAULT_DIRS` 至少一个非空”。其他部署保持原配置时行为不变。

## 5. 组件设计

### 5.1 `directoryGrantStore.ts`

新增专用目录授权存储，避免把跨工具目录边界授权混入现有按工具精确审批记录。

核心接口：

```ts
interface DirectoryGrant {
  id: string;
  userId: string;
  logicalRoot: string;
  physicalRoot: string;
  createdAt: string;
}

interface EffectiveRoot {
  logicalRoot: string;
  physicalRoot: string;
  source: "static" | "owner_default" | "session" | "permanent";
}

hasAccess(userId: string, candidate: string): boolean;
rememberSession(userId: string, root: CanonicalRoot): void;
rememberPermanent(userId: string, root: CanonicalRoot): DirectoryGrant;
listForUser(userId: string): DirectoryGrant[];
revoke(id: string): boolean;
clear(userId?: string): void;
summary(): { session: number; permanent: number };
```

永久数据写入：

```text
%LOCALAPPDATA%\feishu-mcp\directory-grants.json
```

文件格式：

```json
{
  "version": 1,
  "grants": [
    {
      "id": "uuid",
      "userId": "owner",
      "logicalRoot": "C:\\Projects\\demo",
      "physicalRoot": "C:\\Projects\\demo",
      "createdAt": "ISO-8601"
    }
  ]
}
```

写入使用同目录临时文件、`fsync`、原子重命名和尽可能严格的文件权限。日志和 `/health` 只记录数量，不记录目录或用户。

### 5.2 `directoryAuthorization.ts`

新增目录授权协调器，负责：

- 计算规范化逻辑目录和物理目录；
- 校验用户绑定和原始参数摘要；
- 构建一个或多个目录组成的排序目标集合；
- 生成签名 request state 和不可重放 nonce；
- 返回真正的 `input_required` 卡片；
- 处理一次、会话、永久、拒绝四种结果；
- 在批准后把允许结果返回给原工具路径管线。

目录审批 request state 必须绑定：

```text
version
userId
originalTool
argsDigest
sortedLogicalRoots
sortedPhysicalRoots
nonce
```

任何用户、工具参数、目录集合、逻辑路径、物理路径或签名变化均拒绝。

### 5.3 `pathGuard.ts`

将当前只读取模块级 `ALLOWED_DIRS` 的静态守卫拆成两层：

1. 纯检查层：解析候选路径、现有祖先、符号链接/junction、逻辑路径和物理路径，返回“已允许、范围外、内部保护路径或无效路径”。
2. 异步授权层：范围外时调用目录授权协调器，批准后按更新后的有效目录重新校验。

内部授权数据路径在目录卡片生成前直接拒绝，不能通过任何选择放行。

### 5.4 `helpers.ts` 与工具接入

`resolveGuardAndAuthorize()` 成为所有路径型工具的统一入口，并按照以下顺序执行：

```text
工具认证
  -> 参数和路径语法检查
  -> 内部授权数据路径硬拒绝
  -> 有效目录边界检查
  -> 范围外目录 input_required
  -> 批准后重新校验物理路径
  -> 文件扩展名/大小/敏感文件策略
  -> 原工具操作
```

需要迁移或复核的工具：

- `read_file`
- `write_file`
- `edit_file`
- `create_directory`
- `list_directory`
- `move_file`
- `search_files`
- `get_file_info`
- `list_allowed_directories`
- `execute_command` 的 `workdir`
- `search_content`
- `git_status`
- `git_diff`
- `compare_files`
- `apply_patch`

`web_fetch`、todo、`ask_user`、`auth` 和 `ping` 不参与目录授权。

## 6. 授权范围推导

原工具负责提供访问意图，授权协调器按以下规则推导最小目录：

| 请求类型 | 申请范围 |
|---|---|
| 已存在文件 | 文件父目录 |
| 已存在目录 | 该目录本身 |
| 新建文件 | 目标父目录 |
| 新建目录 | 目标目录；若不存在，绑定最近现有物理祖先与缺失后缀 |
| 命令 | `workdir` |
| Git | 仓库/请求目录 |
| 内容或文件搜索 | 搜索根目录 |
| 文件比较 | 两个文件各自父目录，去重后一次展示 |
| 移动 | 源范围和目标范围，去重后一次展示 |
| 多文件补丁 | 所有源/目标父目录，规范化、去重、排序后一次展示 |

多目录卡片必须列出所有范围。只要其中一个目录未授权，操作就不能开始；不存在部分执行或部分持久化。

## 7. 飞书卡片与自动重试

范围外时，原工具返回：

```ts
inputRequired({
  requestState,
  inputRequests: {
    directory_approval: inputRequired.elicit({
      message: renderDirectoryApprovalMessage(...),
      requestedSchema: {
        type: "object",
        properties: {
          decision: {
            type: "string",
            title: "Directory authorization",
            enum: ["allow_once", "allow_session", "allow_permanent", "deny"]
          }
        },
        required: ["decision"]
      }
    })
  }
});
```

卡片消息必须显示：

- 原始工具名称；
- 访问类型（读、写、搜索、命令、Git 或补丁）；
- 每个规范化目录；
- 一次/会话/永久的持续时间说明；
- “永久允许会扩大本地文件访问范围”的风险提示。

SDK 重试同一工具时：

- `allow_once`：只在当前 request state 链中视为允许，不写存储；
- `allow_session`：原子加入当前用户进程内集合，再继续；
- `allow_permanent`：先完成持久化，再继续；持久化失败则不执行原操作；
- `deny`、取消、超时：结构化拒绝，原操作不执行。

目录授权已经满足同一操作的绝对路径确认，避免立即出现第二张绝对路径卡片。敏感文件策略仍可单独触发审批。

## 8. 默认 `F:\` 行为

当请求身份为 `owner` 时，`F:\` 作为 `owner_default` 有效根：

- `F:\` 下所有逻辑和物理子路径无需目录授权卡片；
- 不再因绝对路径本身重复确认；
- 文件类型、大小、敏感文件、命令风险和其他策略继续生效；
- junction 指向其他盘符时，以物理路径为准，离开 `F:\` 后仍需为真实目标目录授权；
- 其他用户没有 `F:\` 默认权限。

## 9. 管理、健康和文档

现有 `manage-feishu-mcp-approvals.bat` 和 `scripts/manage-approvals.ps1` 扩展为同时管理：

- 操作审批；
- 永久目录授权。

列表只显示编号、用户的不可逆短哈希、目录的脱敏摘要和创建时间；支持删除一项目录授权、清理全部目录授权，并保持现有操作审批命令兼容。

`/health` 新增：

```json
{
  "directoryAuthorization": {
    "enabled": true,
    "ownerDefaults": 1,
    "session": 0,
    "permanent": 0,
    "unsupportedClientPolicy": "deny"
  }
}
```

健康接口、启动 Banner 和日志均不得输出真实目录、用户、request state、PIN、Bearer Token 或签名密钥。

README 和飞书接入指南增加：

- `OWNER_USER_ID` / `OWNER_DEFAULT_DIRS`；
- 目录卡片四个选择；
- 默认 `F:\` 的单用户含义；
- 永久目录授权撤销；
- 工具可用范围必须仅限本人，否则固定 `owner` 身份会被共享。

## 10. 错误模型

复用现有结构化结果，并新增明确错误码：

```text
DIRECTORY_APPROVAL_DENIED
DIRECTORY_GRANT_PERSIST_FAILED
DIRECTORY_IDENTITY_REQUIRED
```

行为约束：

- 客户端不支持 `input_required`：返回 `CLIENT_ELICITATION_UNSUPPORTED`；
- 缺少稳定身份：返回 `DIRECTORY_IDENTITY_REQUIRED`；
- 用户拒绝/取消/超时：返回 `DIRECTORY_APPROVAL_DENIED`；
- 永久存储失败：返回 `DIRECTORY_GRANT_PERSIST_FAILED`，原操作不执行；
- 内部授权数据路径：继续返回 `SENSITIVE_PATH`，不生成卡片；
- request state 不匹配、过期或重放：返回 `APPROVAL_DENIED`。

错误消息可以显示用户刚刚申请的目录，但审计日志只记录目标数量和来源类型。

## 11. 测试策略

### 11.1 单元测试

- 配置解析：空值、逗号列表、Windows 盘符根目录、上限和去重；
- 有效根：全局、owner 默认、会话、永久合并及用户隔离；
- 一次授权不存储；会话授权重启清空；永久授权重载恢复；
- 永久存储原子性、撤销和清空；
- 逻辑/物理路径、符号链接、junction、缺失目标和大小写规范化；
- 内部授权数据目录不可授权；
- request state 的签名、用户、工具、参数、目录集合、过期和重放；
- 多目录排序、去重和全有或全无。

### 11.2 工具集成测试

- 每个路径型工具首次越界返回 `input_required`；
- 四个决策结果正确；
- 批准后同一原工具自动完成，不要求智能体另调工具；
- 目录批准后不重复弹绝对路径卡；
- 敏感文件仍按独立策略处理；
- `owner` 访问 `F:\` 不弹目录卡，其他身份会弹；
- 不支持卡片的客户端拒绝且不读 stdin；
- 命令、Git、比较、移动和补丁的多目标行为。

### 11.3 E2E 与回归

- 现代 MCP HTTP 多轮重试；
- 飞书企业内部 MCP 的真实卡片呈现；
- 永久目录授权后重启仍可访问，撤销后再次弹卡；
- `tools/list` 仍严格为原 21 个工具；
- `/health` 仅公开计数；
- PIN、Bearer、并发、补丁回滚、网络守卫、日志脱敏和 ngrok 启动器完整回归；
- 测试仅使用临时目录和生成凭据，不访问真实用户文件。

## 12. 验收标准

1. `owner` 可直接访问整个 `F:\`，无需目录卡片。
2. `owner` 访问其他未允许目录时，原工具直接产生飞书目录授权卡片。
3. 四个决策均按定义执行，且批准后自动重试原工具。
4. 永久授权重启有效、可本机撤销、按用户隔离。
5. 多目录操作在任何文件变化前完成全部授权。
6. junction/symlink 不能利用显示路径与物理路径差异逃逸授权。
7. MCP 自身授权数据目录永远不可访问或授权。
8. 固定 `owner` 身份的工具保持仅本人可用。
9. 公开工具数量保持 21，原有客户端和静态 `ALLOWED_DIRS` 配置保持兼容。
10. 完整 Node、Python、真实 HTTP/ngrok 验收通过，日志无凭据泄漏。

## 13. 发布方式

- 在独立实现分支完成。
- 先提交失败测试，再分层实现存储、路径管线、工具接入、管理脚本和文档。
- 完整回归和真实飞书卡片验证通过后再快进合并 `main`。
- 不强推，不改写已有 `main` 历史。
