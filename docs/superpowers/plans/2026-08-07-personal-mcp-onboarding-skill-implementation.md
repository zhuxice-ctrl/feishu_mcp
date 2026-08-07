# Personal MCP Onboarding Skill Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a project-local, detection-first Skill that teaches an individual developer to manually configure this MCP on their own Windows device.

**Architecture:** Keep the Skill self-contained in one Markdown file with generated picker metadata. It will use existing inspection capability for factual status, then give copyable manual steps without account creation, credential entry, installation, or configuration writes.

**Tech Stack:** Codex Skill Markdown and YAML; Skill Creator Python initializer and validator.

---

## File structure

- Create: `skills/personal-mcp-onboarding/SKILL.md` — trigger metadata, safety boundary and teaching workflow.
- Create: `skills/personal-mcp-onboarding/agents/openai.yaml` — generated user-facing picker metadata.

### Task 1: Initialize the Skill

**Files:**

- Create: `skills/personal-mcp-onboarding/SKILL.md`
- Create: `skills/personal-mcp-onboarding/agents/openai.yaml`

- [ ] **Step 1: Confirm the target is free**

Run:

```powershell
Test-Path -LiteralPath 'skills/personal-mcp-onboarding'
```

Expected: `False`.

- [ ] **Step 2: Generate the standard Skill files**

Run:

```powershell
python 'F:/CodexHome/skills/.system/skill-creator/scripts/init_skill.py' personal-mcp-onboarding --path 'skills' --interface 'display_name=个人 MCP 接入教学' --interface 'short_description=检测本机环境并手动接入 Aily MCP' --interface 'default_prompt=Use $personal-mcp-onboarding to inspect my Windows device and teach me how to manually connect this MCP to Aily.'
```

Expected: `SKILL.md` and `agents/openai.yaml` are created with no resource folders.

### Task 2: Implement detection-first manual guidance

**Files:**

- Modify: `skills/personal-mcp-onboarding/SKILL.md`

- [ ] **Step 1: Set complete trigger metadata**

Replace the template frontmatter with:

```yaml
---
name: personal-mcp-onboarding
description: Teach an individual developer to independently install and use this local MCP on their own Windows computer. Use when asked about personal-device setup, manual ngrok registration or tunnel configuration, Aily MCP connection values, separate-device security, or Android and Windows development prerequisites. Inspect relevant local state first, then provide manual guidance only; never create accounts, enter secrets, install software, or change machine configuration without a separate explicit request.
---
```

- [ ] **Step 2: Write the core workflow**

Add these non-negotiable instructions:

```markdown
1. Identify whether the request needs base Node setup, Android, Windows native, or a combination.
2. Inspect only relevant prerequisites and mark each ready, missing, misconfigured, or not checked.
3. Give manual steps in order: checkout, local `.env`, prerequisites, launch, ngrok, Aily headers, verification.
4. Keep every device independent. Never share `.env`, `MCP_AUTH_TOKEN`, ngrok URLs, allowed directories, or owner identities.
5. Treat machine-changing commands as optional examples. Do not execute them without a separate explicit request.
```

Include only these placeholder values for Aily:

```text
Authorization: Bearer <the user's own MCP_AUTH_TOKEN>
x-aily-user: <the user's own OWNER_USER_ID>
```

State that `Bearer ...` belongs in the actual header input value, not a display-name or description field.

- [ ] **Step 3: Add relevant platform checks and two examples**

Require base checks for Node.js, npm, Git, local `/health`, port 3000, ngrok and the configured tunnel. Require Android checks for Android Studio, SDK root, JDK, `adb`, Gradle wrapper and optional device state. Require Windows native checks for Build Tools, MSVC, Windows SDK, CMake and project build files.

Include two compact examples: Node/Aily/ngrok setup, and an Android machine lacking SDK command-line tools and `adb`. Both start with detection results, list manual actions, then finish with verification. Neither contains a real secret, endpoint, account-registration automation, or an unrequested install command.

### Task 3: Validate, commit and publish

**Files:**

- Test: `skills/personal-mcp-onboarding/SKILL.md`
- Test: `skills/personal-mcp-onboarding/agents/openai.yaml`

- [ ] **Step 1: Validate the Skill**

Run:

```powershell
python 'F:/CodexHome/skills/.system/skill-creator/scripts/quick_validate.py' 'skills/personal-mcp-onboarding'
```

Expected: validation succeeds with no naming or frontmatter errors.

- [ ] **Step 2: Scan for unfinished template text and leaks**

Run:

```powershell
rg -n 'TODO|TBD|\[TODO|MCP_AUTH_TOKEN=' 'skills/personal-mcp-onboarding'
```

Expected: no matches.

- [ ] **Step 3: Review, commit and push**

Run:

```powershell
git diff --check
git add -- skills/personal-mcp-onboarding
git commit -m "feat: add personal MCP onboarding skill"
git push origin main
```

Expected: `main` contains the new Skill and generated picker metadata.
