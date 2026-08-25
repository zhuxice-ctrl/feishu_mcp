# Transport Branching and Onboarding Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Archive the last ngrok release as `ngrok`, promote the verified Cloudflare line to `main`, and make the public setup guidance choose a transport before configuration.

**Architecture:** Git branch names preserve the two transport histories without duplicating source. The Cloudflare `main` documentation and the manual onboarding Skill share one small transport-decision contract: choose Cloudflare/ngrok first, then state whether a dedicated MCP domain exists. Runtime code, `.env`, and tunnel credentials are out of scope.

**Tech Stack:** Git, Markdown, Codex Skill metadata, Node test runner.

---

### Task 1: Preserve the ngrok release line

**Files:**
- Modify: Git references only; no tracked file change.

- [ ] **Step 1: Confirm the archive point is present and precedes the Cloudflare line**

Run:

```powershell
git merge-base --is-ancestor e73f310 HEAD
git show -s --format='%H %s' e73f310
```

Expected: exit code `0`, and subject `docs: prescribe workspace routing protocol`.

- [ ] **Step 2: Create the immutable-named archive branch at the verified commit**

Run:

```powershell
git branch ngrok e73f310
git show -s --format='%H' ngrok
```

Expected: output begins `e73f310`.

- [ ] **Step 3: Publish the archive branch without rewriting any remote history**

Run:

```powershell
git push origin ngrok
```

Expected: remote branch `origin/ngrok` is created; no force option is used.

### Task 2: Make setup documentation transport-aware

**Files:**
- Modify: `README.md`
- Modify: `skills/personal-mcp-onboarding/SKILL.md`
- Modify: `skills/personal-mcp-onboarding/agents/openai.yaml`

- [ ] **Step 1: Update README transport selection and Aily cutover rules**

Add a concise selection table before tunnel setup. State Cloudflare named tunnel is the main path when the user has a dedicated MCP domain; ngrok is supported for temporary use, rollback, or users without such a domain. Replace ambiguous migration wording with this exact ordered rule:

```text
1. Add a new Aily MCP entry for the new endpoint.
2. Verify ping and tool discovery through the new entry.
3. Disable the prior same-purpose MCP entry.
```

State that two same-purpose MCP entries must not be enabled together because duplicate tool inventories make routing ambiguous.

- [ ] **Step 2: Update the onboarding Skill decision gate**

Make the first onboarding action ask these two questions before detection or manual setup:

```text
Which public transport do you want to use: Cloudflare or ngrok?
Do you have an independent domain that can be dedicated to this MCP?
```

Route Cloudflare plus dedicated domain to named-tunnel guidance; route Cloudflare without a dedicated domain to a recommendation for ngrok or acquiring a dedicated domain; route ngrok to the user’s own ngrok account and endpoint. Preserve the manual-only, per-device, no-secret boundary.

- [ ] **Step 3: Align Skill UI metadata**

Update `agents/openai.yaml` description and default prompt so discovery covers Cloudflare and ngrok transport choice, while preserving the existing display name and any policy/dependency fields.

- [ ] **Step 4: Validate Skill structure and secret boundaries**

Run:

```powershell
python F:\CodexHome\skills\.system\skill-creator\scripts\quick_validate.py skills\personal-mcp-onboarding
rg -n "MCP_AUTH_TOKEN=|NGROK_AUTHTOKEN=|cert\.pem|\\.cloudflared" README.md skills\personal-mcp-onboarding
```

Expected: validator succeeds. Search results contain only generic safety guidance or placeholders, never an actual token, certificate, local credential path, or owner ID.

- [ ] **Step 5: Commit documentation and Skill changes**

Run:

```powershell
git add README.md skills/personal-mcp-onboarding/SKILL.md skills/personal-mcp-onboarding/agents/openai.yaml
git commit -F <utf8-no-bom-message-file>
```

Expected: one commit with only the three intended files.

### Task 3: Promote and verify the Cloudflare main line

**Files:**
- Modify: Git references only; no tracked file change.
- Test: `test/launcher.test.mjs`
- Test: `test/startup-launcher.test.mjs`
- Test: `test/cloudflare-tunnel-script.test.mjs`
- Test: `test/public-host-config.test.mjs`

- [ ] **Step 1: Run focused transport regression tests from the Cloudflare line**

Run:

```powershell
npm run build
node --test test/launcher.test.mjs test/startup-launcher.test.mjs test/cloudflare-tunnel-script.test.mjs test/public-host-config.test.mjs
```

Expected: build succeeds and all selected tests pass.

- [ ] **Step 2: Advance local main to the validated Cloudflare tip without creating a divergent merge**

Run:

```powershell
git switch main
git merge --ff-only codex/local-development-workbench-phase-1
git log -1 --oneline
```

Expected: `main` points to the documentation/Skill commit and the operation reports a fast-forward.

- [ ] **Step 3: Publish main and confirm both remote branch tips**

Run:

```powershell
git push origin main
git ls-remote --heads origin main ngrok
```

Expected: remote `main` matches the validated Cloudflare tip and remote `ngrok` begins `e73f310`.

- [ ] **Step 4: Confirm no local secret or unrelated untracked file was added**

Run:

```powershell
git status --short
```

Expected: `.env` is not staged or committed; pre-existing `.commit_msg.txt` and `docs/CLOUDFLARE_TUNNEL_MIGRATION.md` remain untracked and unchanged.
