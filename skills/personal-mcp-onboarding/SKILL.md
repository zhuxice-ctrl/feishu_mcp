---
name: personal-mcp-onboarding
description: Teach an individual developer to independently install and use this local MCP on their own Windows computer. Use when asked about personal-device setup, manual ngrok registration or tunnel configuration, Aily MCP connection values, separate-device security, or Android and Windows development prerequisites. Inspect relevant local state first, then provide manual guidance only; never create accounts, enter secrets, install software, or change machine configuration without a separate explicit request.
---

# Personal MCP Onboarding

Guide one developer through running this repository on their own Windows computer and connecting their own Aily workbench to it. Match the user's language. Keep the guidance manual and detection-first.

## Safety boundary

- Never create an ngrok account, enter a token, write `.env`, install software, alter environment variables, start a tunnel, or change Aily configuration unless the user separately asks to perform that action.
- Never display, repeat, place in a document, or put in a command a real `MCP_AUTH_TOKEN`, ngrok authtoken, owner ID, endpoint, or user directory.
- Treat every device as independent. Do not reuse or share `.env`, tokens, ngrok URLs, allowed directories, or owner identities between computers.
- Explain that source code may be shared through Git; credentials, local build output, and personal machine paths may not.

## Workflow

1. Identify the target: base Node project, Android project, Windows native project, or a combination.
2. Inspect only prerequisites relevant to that target. Prefer the repository's environment-inspection capability when available; otherwise use read-only checks. Mark each item **ready**, **missing**, **misconfigured**, or **not checked**.
3. Give manual steps in this order: clone the repository, make a local `.env`, install missing prerequisites, launch the local MCP, configure ngrok, configure Aily, then verify health and tool discovery.
4. Put all machine-changing commands under **Optional manual action**. Do not run them yourself until the user explicitly requests it.
5. Finish with a compact verification checklist and the next safe action.

## Detection checklist

### Base setup

Check only what is needed and report versions or paths only when they are not sensitive:

- Node.js and npm;
- Git;
- repository dependencies and build state when the repository is present;
- local MCP health endpoint and port 3000 only after the user has started it;
- ngrok executable and an active tunnel only after the user configured one.

For a missing item, provide the official product name, the expected result, and a post-install verification command. Do not automate downloads or account registration.

### Android setup

For an Android project, additionally check Android Studio, `ANDROID_HOME` or `ANDROID_SDK_ROOT`, a JDK compatible with the project, Android SDK platform tools and `adb`, the project Gradle wrapper, and a connected device only when the user wants device testing.

When an Android prerequisite is missing, explain the manual Android Studio SDK Manager setting or environment variable to configure, then give one safe verification command such as `adb version` or `./gradlew --version`.

### Windows native setup

For a Windows native project, additionally check Visual Studio Build Tools or Visual Studio with the Desktop development with C++ workload, MSVC, a Windows SDK, CMake when the project uses it, and the project's build entry point.

Explain the required workload and verification command, but do not invoke an installer or change the machine automatically.

## Manual connection guidance

### Local configuration

Tell the user to copy `.env.example` to a local `.env` and generate their own long random MCP transport token. Their allowed directories must be only their own project roots. Do not show a real `.env` or claim default values that have not been checked in the installed version.

### ngrok

Tell the user to create their own ngrok account, install ngrok, add their own authtoken locally, and expose the locally running MCP port. They must copy the resulting personal HTTPS endpoint and append the repository's MCP path. Explain that a free ngrok domain can change after a restart, so the Aily MCP endpoint must be updated when it changes.

### Aily

Give only these placeholders:

```text
MCP endpoint: https://<the-user's-ngrok-domain>/mcp
Authorization: Bearer <the-user's-own-MCP_AUTH_TOKEN>
x-aily-user: <the-user's-own-OWNER_USER_ID>
```

State explicitly: `Bearer ` plus the token belongs in the actual request-header input value. A display name or description field is only explanatory text and does not send the authorization value.

## Response shape

Use these sections when relevant:

1. **Detection result** — a short status table.
2. **Manual setup steps** — numbered and dependency ordered.
3. **Aily connection values** — placeholders only.
4. **Android or Windows prerequisites** — only for the chosen target.
5. **Verification** — expected local health and Aily tool discovery outcome.
6. **Security notes** — device independence and secret handling.

## Teaching examples

### Node project connected through ngrok

Start by reporting whether Node, npm, Git, the repository, the local health endpoint, and ngrok are ready. If the local server is not running, tell the user to start it manually with the repository-provided launcher. Then guide them to configure their own tunnel, copy their own endpoint into Aily, enter the authorization header with `Bearer ` in the real input field, and verify that Aily can enumerate the MCP tools. Do not provide an actual endpoint or token.

### Android machine without SDK command-line tools or adb

Report Android Studio and JDK status, then mark SDK command-line tools and platform tools as missing. Tell the user to open Android Studio's SDK Manager, install the required command-line and platform tools for their project, set the SDK root if necessary, reopen the terminal, and verify with `adb version`. Only after that, continue with the base MCP and Aily connection steps.
