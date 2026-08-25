# Transport Branching and Onboarding Design

## Goal

Preserve the verified historical ngrok implementation as a named Git branch,
promote the verified Cloudflare transport line to `main`, and make both the
README and onboarding Skill choose a transport deliberately before giving setup
steps.

## Branch contract

- Create `ngrok` at commit `e73f310`. This is the last commit before the
  Cloudflare transport migration and already contains the workspace-routing
  feature set.
- Retain the existing ngrok code and configuration keys as a rollback option;
  do not delete them in this change.
- Fast-forward or otherwise non-destructively update `main` to the current
  Cloudflare line after verifying it includes `e73f310` and the Cloudflare
  health acceptance is already satisfied.
- Push `main` and `ngrok` as separate remote branches. Do not force-push.

## Transport selection contract

The onboarding flow begins with exactly two decisions, before prerequisite or
configuration guidance:

1. Which transport does the user choose: Cloudflare or ngrok?
2. Does the user have an independent domain they can dedicate to this MCP?

Routing is deterministic:

| Transport choice | Independent MCP domain | Guidance |
| --- | --- | --- |
| Cloudflare | Yes | Use a Cloudflare named tunnel and a dedicated hostname such as `mcp.<domain>`. |
| Cloudflare | No | Do not use an unrelated business domain by default. Recommend ngrok or obtaining a dedicated MCP domain before continuing. |
| ngrok | Either | Use the user’s own ngrok account and URL. Explain URL persistence limits and that ngrok is the rollback or temporary path. |

No branch selection, account login, tunnel start, `.env` write, service change,
or Aily endpoint change is implied by this guidance. Credentials, local paths,
Cloudflare certificates, tunnel JSON, tokens, and owner IDs remain outside Git
and outside instructional examples.

## README contract

The Cloudflare `main` README will describe Cloudflare named tunnels as the
primary transport and ngrok as a supported fallback. It will document the safe
Aily cutover sequence:

1. Create a new Aily MCP entry for the selected Cloudflare endpoint.
2. Verify `ping` and tool discovery against that entry.
3. Disable the previous ngrok MCP entry.

It will explicitly forbid enabling two same-purpose MCP entries concurrently,
because duplicate tool inventories can produce ambiguous tool selection.

## Onboarding Skill contract

`personal-mcp-onboarding` stays manual and detection-first. Its description,
workflow, connection placeholders, and teaching examples will cover both
transports without treating a real hostname as a credential. It will instruct
the agent to ask the two transport questions first and use provider-appropriate
placeholders only after the answer is known.

## Validation and completion

- Confirm `ngrok` resolves to `e73f310` and `main` resolves to the verified
  Cloudflare tip.
- Verify the README has no real credential material and contains the transport
  choice and no-duplicate-server rule.
- Validate the Skill structure with `quick_validate.py` and inspect its routing
  text for the two required questions.
- Run the relevant documentation/Skill tests if the repository provides them,
  plus the existing focused tunnel and launcher tests affected by the branch
  contents.
- Leave `.env`, cloudflared credential files, `.commit_msg.txt`, and the
  untracked migration document untouched.
