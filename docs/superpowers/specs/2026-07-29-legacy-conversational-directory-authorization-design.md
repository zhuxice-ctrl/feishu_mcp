# 飞书旧 MCP 客户端会话内目录授权兼容设计

## 1. 背景

当前目录授权依赖 MCP `input_required`。服务端在现代客户端中可以返回签名
request state 和四选一表单，客户端提交选择后自动重新进入原工具。但当前飞书
Aily MCP 调用没有声明或转发该能力，因此越界目录请求只能得到
`CLIENT_ELICITATION_UNSUPPORTED`。飞书智能体随后显示的“补充信息”属于智能体
层交互，并不能作为 MCP request state 回传。

本设计为这种旧客户端增加 owner 专属的会话兼容通道。用户不再修改 `.env`、
`ALLOWED_DIRS` 或重启服务；现代客户端的原生 `input_required` 流程保持不变。

## 2. 已确认的信任模型

- 固定请求身份 `OWNER_USER_ID` 代表设备所有者本人。
- 兼容通道只允许该身份使用，其他身份继续安全拒绝。
- 飞书企业内部 MCP 工具必须仅 owner 可见，并继续携带有效 Bearer Token 和固定
  owner 请求头。
- 飞书旧客户端不能提供服务端可验证的原生点击证明。因此服务端信任私有 owner
  智能体在用户明确选择后提交决定。这是纯会话授权的必要取舍。
- 软件包默认不启用兼容通道；只有显式配置的部署改变行为。

## 3. 配置

新增：

```env
DIRECTORY_APPROVAL_FALLBACK=deny
```

合法值：

- `deny`：默认值。旧客户端继续返回 `CLIENT_ELICITATION_UNSUPPORTED`。
- `owner`：只有 `OWNER_USER_ID` 可以通过现有 `auth` 工具提交目录决定。

当前设备使用：

```env
DIRECTORY_APPROVAL_FALLBACK=owner
```

配置为 `owner` 时必须同时存在非空 `OWNER_USER_ID`，否则启动失败。不得根据
`AUTH_MODE`、`OWNER_DEFAULT_DIRS` 或单纯存在 Bearer Token 自动开启 fallback。

## 4. 公共工具契约

公开工具仍严格为 21 个，不新增 `approve_directory` 或
`request_directory_access`。

现有 `auth` 工具向后兼容扩展：

```ts
{
  pin?: string;
  directoryApproval?: {
    challenge: string;
    decision: "allow_once" | "allow_session" | "allow_permanent" | "deny";
  };
}
```

- 仅提供 `pin` 时保持原登录行为。
- 提供 `directoryApproval` 时处理目录挑战；不得同时改变 PIN 登录状态。
- 未提供任何字段时保持现有认证错误语义。
- 目录决定必须要求当前请求具有稳定 owner 身份，并且该身份已经满足当前
  `AUTH_MODE`。`AUTH_MODE=none` 视为已满足；PIN 模式要求已有有效 PIN 会话。

## 5. 旧客户端授权流程

### 5.1 产生挑战

路径管线仍依次完成：

```text
工具鉴权
→ 参数检查
→ 内部审批数据路径硬拒绝
→ 逻辑/物理路径解析
→ 现有有效根检查
→ 推导并批量规范化缺失目录
```

只有在目录确实越界、身份等于 `OWNER_USER_ID`、fallback 为 `owner` 且客户端不
支持 `input_required` 时才产生挑战。结果为结构化、可重试错误：

```json
{
  "ok": false,
  "code": "DIRECTORY_APPROVAL_REQUIRED",
  "message": "Explicit owner approval is required before retrying this tool.",
  "retryable": true,
  "directoryApproval": {
    "challenge": "opaque-signed-value",
    "tool": "read_file",
    "access": "read",
    "directories": ["C:\\Projects\\demo"],
    "decisions": ["allow_once", "allow_session", "allow_permanent", "deny"],
    "expiresAt": "ISO-8601"
  }
}
```

仅展示规范化逻辑目录。物理目录、参数正文、Bearer、PIN、签名密钥和持久化路径
不得作为展示字段或日志字段输出。

### 5.2 签名挑战

挑战复用现有 approval request-state 密钥和 TTL，但使用独立 payload kind：

```ts
interface LegacyDirectoryChallengePayload {
  version: 1;
  kind: "legacy_directory";
  userId: string;
  tool: string;
  argsDigest: string;
  rootsDigest: string;
  roots: CanonicalDirectoryRoot[];
  nonce: string;
  expiresAt: string;
}
```

签名与 SDK request-state 一样绑定当前请求身份。提交时必须重新校验：

- payload 类型和版本；
- 当前身份等于 payload userId 和 `OWNER_USER_ID`；
- fallback 仍为 `owner`；
- TTL 未过期；
- nonce 未使用；
- roots 重新规范化后的摘要等于 rootsDigest；
- 每个目录仍不属于内部审批数据范围。

任何失败返回 `APPROVAL_DENIED`，且不能写入授权存储。

### 5.3 提交决定

智能体得到用户明确选择后调用：

```json
{
  "directoryApproval": {
    "challenge": "opaque-signed-value",
    "decision": "allow_session"
  }
}
```

服务端先完成全部验证，再原子消费 nonce：

- `deny`：记录拒绝结果，不保存授权；挑战不可重放。
- `allow_session`：把完整目录批次加入当前用户的进程内目录根。
- `allow_permanent`：原子持久化完整目录批次；失败时返回
  `DIRECTORY_GRANT_PERSIST_FAILED`，原工具不得执行。
- `allow_once`：创建一个短期、单次、完全匹配的 pending 许可，不写 session 或
  permanent 存储。

成功结果只返回决定、原工具名和“立即重试原工具”的机器可读提示，不返回原始
参数：

```json
{
  "ok": true,
  "directoryApproval": {
    "decision": "allow_once",
    "retryTool": "read_file",
    "retryOriginalCall": true
  }
}
```

### 5.4 自动重试

旧客户端无法由服务端直接重新进入原 MCP tool handler，因此“自动重试”由智能体
编排：`auth` 成功结果明确要求立即用原参数重试原工具。从用户视角仍是一次授权
后继续原操作，不需要修改本机配置或再发一条指令。

`auth` 不保存或回显原始工具参数，也不从签名挑战中执行文件操作，避免把文件
内容、补丁或命令复制进授权状态。

## 6. `allow_once` 消费模型

新增进程内 one-shot coordinator，记录：

```text
userId + tool + argsDigest + rootsDigest + canonical roots + expiresAt
```

原工具重试时，目录授权层在产生新挑战前查询并原子消费完全匹配的记录：

- 用户、工具、参数摘要、目录集合全部匹配才允许。
- 每条记录只能消费一次。
- 不匹配的工具调用不能消费或继承它。
- 记录在授权 TTL 后清理，进程重启后消失。
- 多目录记录作为整体消费，不提供部分授权。

消费后，现有 request-local 临时目录根继续负责 trash、原子写和后续文件操作的
边界检查；one-shot 记录本身不进入 session/permanent 根集合。

## 7. 现代客户端与其他身份

- 有 MCP `input_required` envelope 的客户端继续执行现有签名表单流程，不产生
  fallback 挑战。
- fallback 为 `deny` 时保持当前行为。
- 非 owner、缺少身份或身份不稳定时保持结构化安全拒绝。
- 内部审批数据路径在任何客户端中都返回 `SENSITIVE_PATH`，不产生挑战。
- 现有命令、网络、敏感文件和普通 `ask_user` 的客户端兼容策略不在本次范围内；
  本次只解决目录边界授权。

## 8. 错误模型

新增：

```text
DIRECTORY_APPROVAL_REQUIRED
DIRECTORY_APPROVAL_EXPIRED
```

保留：

```text
DIRECTORY_APPROVAL_DENIED
DIRECTORY_GRANT_PERSIST_FAILED
DIRECTORY_IDENTITY_REQUIRED
APPROVAL_DENIED
CLIENT_ELICITATION_UNSUPPORTED
SENSITIVE_PATH
```

只有 `DIRECTORY_APPROVAL_REQUIRED` 为可重试。过期、拒绝、篡改、重放或身份不匹配
都不执行原工具。

## 9. 日志与健康接口

- 日志只记录事件类型、工具名、目录数量、决定和来源
  `legacy_owner_fallback`，不记录用户原值、目录、challenge 或参数。
- `/health` 在 `directoryAuthorization` 中增加：

```json
{
  "fallback": "owner"
}
```

- Banner 只输出 `Directory fallback: owner`，不得输出 owner 值。
- 管理脚本和永久授权文件格式保持不变。

## 10. 测试与验收

### 10.1 单元测试

- 配置默认 `deny`，`owner` 要求非空 `OWNER_USER_ID`。
- auth 原 PIN 输入保持兼容。
- owner 可提交合法挑战，非 owner 和空身份拒绝。
- 挑战签名、用户、工具、参数、目录摘要、TTL 和 nonce 篡改或重放全部拒绝。
- `deny` 不写任何授权。
- session/permanent 批次保持全有或全无。
- permanent 写失败不创建 one-shot/session 许可。
- one-shot 仅由下一次完全匹配调用消费，过期和重启后失效。
- 内部审批目录不产生挑战。

### 10.2 HTTP E2E

使用旧客户端请求形态：

1. owner 请求 owner 默认根外的临时文件；
2. 获得 `DIRECTORY_APPROVAL_REQUIRED` 和签名 challenge；
3. 调用 auth 提交 `allow_once`；
4. 重试原 read_file 并成功；
5. 再次调用时重新要求授权；
6. 分别验证 session、permanent、deny、重启和撤销；
7. 验证非 owner 仍为 `CLIENT_ELICITATION_UNSUPPORTED`；
8. 验证现代 HTTP MRTR 流程保持通过。

### 10.3 回归标准

- `tools/list` 严格为 21。
- Node、Python、typecheck、audit 和 `git diff --check` 全部通过。
- 固定 ngrok 域名下旧客户端真实飞书会话完成一次 owner 目录授权。
- 不访问或记录真实敏感文件；真实验收使用生成的临时目录。

## 11. 发布方式

- 在现有 `codex/conversational-directory-authorization` 分支继续提交设计、实现和测试。
- 更新当前草稿 PR，不直接修改 main。
- 部署验收通过后再由用户批准合并。
- 不 force push，不修改旧部署 `.env`，只在当前设备新服务配置中显式加入
  `DIRECTORY_APPROVAL_FALLBACK=owner`。
