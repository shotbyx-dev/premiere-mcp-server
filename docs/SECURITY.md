# PremierePilot — Security Notes

**PremierePilot by Shotbyx.** Please read this before exposing your rig to the
internet. The short version: the server runs on *your* PC, talks to *your* Adobe
apps, and everything it does is written to a local audit log. Your footage never
leaves your machine unless you explicitly ask the AI to fetch or generate
something from the web.

---

## 1. Exact capability surface — what the 59 tools can touch

The server exposes **59 tools**: 35 for Premiere Pro, 23 for After Effects, plus
a `search_tools` catalog. They run as ExtendScript inside Premiere/AE through
the CEP / ScriptUI bridge panels — which means your AI assistant gets
**Premiere's full file access**:

- **Your project files:** open, create, save projects and compositions; read and
  modify sequences, comps, layers, bins, markers, keyframes, expressions, effects.
- **Your media folders:** import media from local paths (`import_media`) or from
  a URL you approve (`import_media_from_url` — downloads to your assets dir,
  default `C:\Shotbyx\AI_Clips`, max 500 MB per clip with a content-type check).
- **Your exports:** Media Encoder export queue, `aerender` render queue, frame
  export, render-queue status.
- **Destructive actions are possible:** trimming, moving, splitting, and deleting
  timeline clips and layers; overwriting exports; saving over projects. Your
  assistant is instructed to confirm before anything it can't undo — and you
  should verify before delivery.
- **Escape hatches exist:** both toolsets include a raw ExtendScript / raw
  command tool for anything not covered by the curated tools. Treat these as
  "the AI can run arbitrary scripting commands inside your Adobe apps."

In short: anyone holding your bearer token can do to your Adobe projects
anything the curated tools plus ExtendScript can do. Guard the token like a
password.

## 2. Audit log — location and format

Every tool call is appended to **`audit.jsonl`** (JSON Lines), one record per
call:

- **Location:** set `PREMIERE_MCP_AUDIT` in `.env`, or it defaults to
  `<assets-dir>/../audit.jsonl` — i.e. next to your assets folder
  (default install: `C:\Shotbyx\audit.jsonl`).
- **Contents per record:** timestamp, caller identity, tool name, argument
  summary, outcome (success/error).
- **Redactions:** bearer tokens and large/base64 payloads are redacted before
  writing.
- **Retention:** the file grows forever — rotate or archive it yourself if it
  gets large. It is never sent anywhere; it stays on your PC.

If you ever wonder "what did it just do?", this file is the answer.

## 3. What the AI can NEVER do

- **See your screen.** There is no screen capture, no screenshots of your
  desktop. (The `export_frame` tool renders a frame from the program monitor via
  Premiere itself — that is an export, not surveillance.)
- **Move your mouse or type keystrokes.** It drives the apps only through the
  plugin/scripting bridges, never through simulated input.
- **Reach outside the tools.** It cannot browse your filesystem at will, run
  arbitrary programs, or touch anything the tool catalog doesn't expose.
- **Upload your footage.** Your media never leaves your machine unless you
  explicitly ask the AI to generate a clip or fetch media from a URL — and even
  then, only that specific clip is downloaded *to* your PC.

## 4. Revoking access

- **Rotate the token (instant lockout):** change `PREMIERE_MCP_TOKEN` in the
  repo's `.env` (min 16 chars) and restart the server (the logon scheduled task
  picks it up on next logon, or restart the task now). Every previously paired
  client is rejected immediately.
- **Full uninstall:** stop the server, remove the logon scheduled task, stop and
  remove the cloudflared tunnel service, delete the bridge panels from
  Premiere/AE, and delete the repo folder. Your projects, media, and exports are
  untouched — only PremierePilot's own pieces come out.

## 5. Tunnel security notes

- The server **binds 127.0.0.1 only** (default port `8787`) — it is never
  directly reachable from your LAN or the internet. **Do not port-forward
  this port.**
- Remote access goes through **Cloudflare Tunnel** (`cloudflared` installed as a
  Windows service by the installer with `-TunnelToken`). The tunnel is
  outbound-only from your PC; nothing listens on a public port.
- `/health` is the only unauthenticated endpoint. `/mcp` requires
  `Authorization: Bearer <PREMIERE_MCP_TOKEN>` on every request.
- If your tunnel hostname changes, update your AI client with the new
  `https://<your-host>/mcp` URL — the token stays the same unless you rotate it.

## 6. Responsible use

- Run the server only on machines you own or administer, and only against
  projects and media you have the rights to.
- Keep the token secret. Anyone with it has the full capability surface above.
- Review AI-driven edits before export — the audit log is your receipt.
- Report security issues at
  [github.com/shotbyx-dev/premiere-mcp-server](https://github.com/shotbyx-dev/premiere-mcp-server)
  rather than in public issues.
