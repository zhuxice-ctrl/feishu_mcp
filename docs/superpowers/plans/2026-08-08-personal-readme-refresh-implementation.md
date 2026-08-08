# Personal README Refresh Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rewrite the README's entry path for individual Windows developers while keeping current MCP capabilities, safety boundaries and manual ngrok/Aily setup accurate.

**Architecture:** Modify `README.md` only. Add a short personal setup path before the complete reference, derive the tool count and policy wording from `src/index.ts`, `src/config.ts` and `src/tools/command.ts`, and preserve detailed material as secondary reference.

**Tech Stack:** Markdown, Node.js/TypeScript build verification, ripgrep consistency checks.

---

## File structure

- Modify: `README.md` — personal onboarding, current tools, configuration and launcher behavior.

### Task 1: Verify current facts before documentation changes

**Files:**

- Inspect: `src/index.ts`
- Inspect: `src/config.ts`
- Inspect: `src/tools/command.ts`
- Inspect: `skills/personal-mcp-onboarding/SKILL.md`

- [ ] **Step 1: Obtain the authoritative tool inventory**

Run:

```powershell
rg -n 'TOOL_NAMES|manage_binary_artifact|execute_command|toolCount' src/index.ts
```

Expected: the 31 registered tool names, including `execute_command` and
`manage_binary_artifact`.

- [ ] **Step 2: Obtain the authoritative owner command policy wording**

Run:

```powershell
rg -n 'OWNER_COMMAND_POLICY|OWNER_USER_ID|required when OWNER_USER_ID|direct' src/config.ts src/tools/command.ts
```

Expected: `approval` is the default; `direct` requires `OWNER_USER_ID` and
does not bypass directory, protected-path, timeout, output or audit controls.

- [ ] **Step 3: Verify the personal onboarding Skill target**

Run:

```powershell
rg -n 'Android|Windows|ngrok|Aily|Safety boundary' skills/personal-mcp-onboarding/SKILL.md
```

Expected: the README can link to the Skill for detection-first manual guidance.

### Task 2: Replace the README's opening with a personal setup path

**Files:**

- Modify: `README.md`

- [ ] **Step 1: Add a personal-use positioning and safety summary immediately after the title**

Add concise Chinese copy that states each device owns its own `.env`, token,
allowed directories, ngrok endpoint and Aily connection. State that Git source
may be shared but tokens, endpoints, logs and personal paths must not be shared
or committed.

- [ ] **Step 2: Add a “10 分钟个人接入” section before the full feature list**

Use six numbered actions:

```markdown
1. 克隆并安装依赖。
2. 复制 `.env.example` 为 `.env`，只配置自己的目录和随机 Token。
3. 启动 `start-feishu-mcp.bat` 并确认本地 `/health`。
4. 在自己的 ngrok 账号中手动建立到本地 3000 端口的 HTTPS 隧道。
5. 在 Aily 中使用个人 HTTPS `/mcp` 地址和请求头。
6. 用 `ping` 或 `tools/list` 验证连接。
```

Show header placeholders only:

```text
Authorization: Bearer <你的 MCP_AUTH_TOKEN>
x-aily-user: <你的 OWNER_USER_ID>
```

State that the Authorization value belongs in the real header input, not a
display name or description field.

- [ ] **Step 3: Add local Android and Windows development guidance**

Link to `skills/personal-mcp-onboarding/SKILL.md`. State that it detects Node,
Git, ngrok, Android Studio, SDK, JDK, `adb`, Visual Studio Build Tools, MSVC,
Windows SDK and CMake, then gives manual next steps. State that it does not
register accounts, install software or enter secrets.

### Task 3: Correct capability and policy reference sections

**Files:**

- Modify: `README.md`

- [ ] **Step 1: Replace outdated tool totals and grouping**

Change all `30` and `21 + 9` tool-count statements to 31. Keep the existing
table but include `manage_binary_artifact` and accurately describe
`execute_command` as the existing command tool. Do not say command execution is
absent.

- [ ] **Step 2: Add a bounded owner build-verification note**

Add a dedicated section containing:

```text
OWNER_COMMAND_POLICY=approval  # default
OWNER_COMMAND_POLICY=direct    # only with OWNER_USER_ID
```

Explain that direct applies only to the configured owner and only bypasses the
ordinary per-command approval. It continues to enforce directory authorization,
protected internal data exclusion, time/output limits, cancellation, audit and
concurrency controls.

- [ ] **Step 3: Correct launcher and ngrok claims**

State that the launcher requires local health and tunnel registration. A public
health probe may warn under Clash Fake-IP and must not stop a healthy local MCP
and tunnel. Replace any claim that a free fixed ngrok domain is guaranteed with
the user's active tunnel or separately configured reserved domain.

### Task 4: Validate and publish

**Files:**

- Test: `README.md`

- [ ] **Step 1: Scan stale assertions and secret-like examples**

Run:

```powershell
rg -n '30 个 MCP|30 个工具|21 项|9 个开发|tools/list.*30|MCP_AUTH_TOKEN=[^y<]' README.md
```

Expected: no stale tool-count claims or real token assignment.

- [ ] **Step 2: Build the project**

Run:

```powershell
npm run build
```

Expected: TypeScript completes with exit code 0.

- [ ] **Step 3: Review, commit and push the documentation change**

Run:

```powershell
git diff --check
git add -- README.md
git commit -m "docs: refresh personal setup guide"
git push -u origin codex/personal-readme-refresh
```

Expected: the update is available on a reviewable branch without changing
runtime behavior.
