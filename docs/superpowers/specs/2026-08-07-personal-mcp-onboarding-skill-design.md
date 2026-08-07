# Personal MCP Onboarding Skill Design

## Goal

Add a project-local Codex Skill that teaches an individual developer how to
run this MCP on their own Windows machine and attach it to their own Aily
workbench. It must diagnose the local environment first, then provide manual,
copyable next steps tailored to the result.

## Scope

The Skill covers:

- cloning and starting this repository on a separate personal computer;
- creating a separate local configuration and MCP transport token;
- manually creating and configuring an ngrok tunnel;
- adding the resulting MCP endpoint and request headers to Aily;
- detecting prerequisite state for Node.js, Git, the local MCP service and the
  tunnel;
- detecting Android Studio, Android SDK, JDK and `adb` for Android projects;
- detecting Visual Studio Build Tools, MSVC and Windows SDK for Windows
  projects.

The Skill is instructional. It may inspect local state through existing MCP
tools or safe shell checks, but it does not install software, create accounts,
set secrets, alter environment variables, start a tunnel, or modify project
files unless the user explicitly requests a separate action.

## Location and triggering

Create `skills/personal-mcp-onboarding/SKILL.md` in this repository. Its
metadata must trigger for requests about personal-device installation, manual
ngrok setup, Aily MCP attachment, Android or Windows development prerequisites,
or independently using this repository on another computer.

## Workflow

1. Identify the requested target: basic Node project, Android project, Windows
   native project, or a combination.
2. Inspect only the relevant local prerequisites. Report each as ready, missing,
   misconfigured, or not checked.
3. Give manual steps in dependency order: source checkout, local `.env`,
   prerequisite installation, local launch, tunnel setup, Aily configuration,
   and a health/tool-list verification.
4. Keep credentials private. Refer to a token placeholder only and instruct the
   user to enter `Bearer <their token>` in the actual Aily input value, not in
   a description field.
5. Explain that every device owns its own `.env`, token, allowed directories,
   ngrok endpoint and Aily connection. Never suggest sharing any of these.
6. When a command would change the machine, label it as optional and wait for
   a separate user request before executing it.

## Output contract

Use the following headings when applicable:

- **Detection result** — concise state table.
- **Manual setup steps** — numbered, copyable commands and UI values.
- **Aily connection values** — endpoint and header names, with secret values
  represented only as placeholders.
- **Project-specific prerequisites** — Android and/or Windows instructions.
- **Verification** — expected local health result and Aily tool discovery.
- **Security notes** — independent credential and directory ownership.

Do not claim a service is reachable without checking it. Do not show, echo or
put a real token into generated documentation, terminal output, or an Aily
description field.

## Validation

Validate the new Skill's frontmatter and folder naming with the Skill Creator
validator. Forward-check its instructions against two representative prompts:

1. A new personal Windows device attaching a Node project to Aily through a
   manually configured ngrok tunnel.
2. A personal Android developer machine missing Android SDK command-line tools
   and `adb`.

The expected behavior is an accurate detection-first manual guide, with no
unrequested mutation or credential disclosure.
