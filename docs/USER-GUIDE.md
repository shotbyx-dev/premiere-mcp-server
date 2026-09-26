# PremierePilot — User Guide

**PremierePilot by Shotbyx** is a free, open-source MCP server that runs on your
Windows editing PC and lets an AI assistant (Muse, or any client that can send
an `Authorization: Bearer` header) drive **Adobe Premiere Pro** (35 tools) and
**After Effects** (23 tools) by plain chat prompts.

Repo: [github.com/shotbyx-dev/premiere-mcp-server](https://github.com/shotbyx-dev/premiere-mcp-server)

---

## 1. Install (on the Windows PC)

**Prerequisites:** Windows 10/11, Premiere Pro and After Effects installed,
signed in to Creative Cloud.

1. Clone the repo:
   ```powershell
   git clone https://github.com/shotbyx-dev/premiere-mcp-server.git
   cd premiere-mcp-server
   ```
2. Run the installer in PowerShell:
   ```powershell
   .\scripts\install-windows.ps1
   ```
   For remote access (control the rig from anywhere), pass a Cloudflare Tunnel token:
   ```powershell
   .\scripts\install-windows.ps1 -TunnelToken "YOUR_TUNNEL_TOKEN" -PublicHostname "https://your-tunnel-url.example.com"
   ```

   The installer:
   - installs Node.js 20+ and ffmpeg via winget (if missing),
   - runs `npm install` + build,
   - copies the Premiere CEP bridge panel and the After Effects ScriptUI panel,
   - enables `PlayerDebugMode` (so the unsigned bridge panel loads),
   - generates a secret `PREMIERE_MCP_TOKEN` in `.env`,
   - creates the bridge folders, and registers a logon scheduled task so the server starts with Windows.

3. Open the bridge panels (once per Adobe app launch):
   - **Premiere Pro:** `Window > Extensions > MCP Bridge` (the bridge starts automatically).
   - **After Effects:** `Window > MCP Bridge Auto.jsx` — keep **auto-run ON**.

## 2. Connect your AI

Give your assistant two things: your tunnel URL (`https://your-tunnel-url.example.com/mcp`)
and the bearer token from the repo's `.env` (`PREMIERE_MCP_TOKEN`).

### Option A — Meta Muse (recommended)

Muse has a public connector platform ([muse.ai/platform](https://muse.ai/platform)),
and PremierePilot is being submitted there as an **"Existing MCP"** connector —
once listed, connecting is one click.

**Until then, anyone can already connect today** via Muse's custom-connector
path: paste your server URL in chat (about a minute, no review). Muse sends the
bearer token it already supports, so this path works **right now** with the
current build.

### Option B — ChatGPT (developer mode)

There is **no public ChatGPT app-directory listing path** for PremierePilot:
OpenAI's directory requires one fixed URL shared by all users, and every user
runs their own server on their own PC — so a self-hosted product like this can't
qualify. The honest ChatGPT path is **manual setup via developer mode**:

1. You need a **paid ChatGPT plan**.
2. Open ChatGPT **Settings** and enable **Developer mode**.
3. Go to **chatgpt.com/plugins**, click **+**, and paste your server URL.
4. Choose **OAuth** and create the connector.

> **Note:** the OAuth 2.1 + Dynamic Client Registration layer is on the roadmap
> and landing soon — it is what powers the "choose OAuth" step above. If it
> hasn't landed in your build yet, hold this option until it does; Options A and
> C work today.

### Option C — Claude (custom connector)

Claude connects through a custom connector with OAuth — same story as Muse:
paste your URL, complete OAuth, and you're in.

## 3. Your first 10 prompts

Copy-paste these into your chat. Start with the connection check, then work
down the list.

1. **Check the connection**
   > Use `verify_premiere_connection` and tell me if Premiere Pro is reachable.

2. **Open a project**
   > Open my project `C:\Projects\wedding_edit.prproj` and tell me its name and how many sequences it has.

3. **Look around the project**
   > List the bins in my project and show me the first 20 items in the root.

4. **Build a rough cut**
   > Create a sequence called "Rough cut", then lay these clips on the timeline in order: `C:\Footage\intro.mp4`, `C:\Footage\ceremony.mp4`, `C:\Footage\reception.mp4`.

5. **Cut to the beat**
   > Import `C:\Music\track.mp3`, analyze it with `detect_beats` (write the beat markers on the sequence), then split the video clips at every beat.

6. **Transitions**
   > Add a cross dissolve between every clip on the timeline.

7. **Polish**
   > Add a text overlay that says "The Henderson Wedding" at the start of the sequence for 5 seconds, then export the sequence to `C:\Exports\cut.mp4`.

8. **Bring in AI-generated video**
   > Animate this still into a 5-second cinematic drone-style clip, then import it into my project with `import_media_from_url` and add it at the start of the sequence.
   > *(Your assistant generates the video on its own side — no paid APIs, no API keys — then the server downloads and imports it.)*

9. **After Effects title card**
   > Make me a 5-second title card in After Effects: 1920×1080 comp called "Title card", dark background, white text "Coming Soon" that scales up from 90% to 100% over the 5 seconds, then render it to `C:\Exports\title.mp4`.

10. **Wrap up and verify**
    > Save the Premiere project and the After Effects project, then check the render queue status and confirm nothing is still rendering.

---

## Tips for a happy rig

- **Keep Premiere Pro / After Effects open.** The AI drives them through the bridge panels — closed app = no response.
- **Dismiss modal dialogs promptly.** A save prompt, missing-media dialog, or plugin error wedges the bridge until a human clicks it. The `probe_modal_dialog` tool tells you exactly what's blocking.
- **PC must not sleep.** Settings → System → Power → *never* sleep on AC. A sleeping PC kills the tunnel and both apps.
- **Stay signed in to Creative Cloud.** Sign-out popups block the bridge.
- **Run in a logged-in desktop session.** Premiere/AE need a GUI; headless doesn't work. (RDP counts.)
- **Check the audit log** (`audit.jsonl`, next to your assets dir — default `C:\Shotbyx\audit.jsonl`) whenever you wonder "what did it just do?" — every tool call is recorded there.
- **Prefer dialog-free workflows:** relink media first, turn off "show save dialog"-style prompts, keep plugins licensed.
- **Long songs take a few seconds** for `detect_beats` — it runs locally on your PC, so no audio ever leaves the machine.
