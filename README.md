# premiere-mcp-server

**Created by Shotbyx.**

A Windows-first MCP server that lets an AI chat client drive **Adobe Premiere Pro**
and **Adobe After Effects** with natural-language prompts: open projects, import
footage, build timelines and compositions, animate, apply effects, and export —
from anywhere.

```
ChatGPT / Muse  --->  HTTPS  --->  Cloudflare Tunnel  --->  127.0.0.1:8787/mcp
                                                       (this server, bearer auth)
                                   +-- file queue --> Premiere CEP panel --> ExtendScript
                                   +-- file queue --> AE ScriptUI panel  --> ExtendScript
```

**Video generation:** no paid APIs, no API keys. The assistant generates video
itself (e.g. `media.generate_video`), uploads it to a share URL, and the server
downloads + imports it via `import_media_from_url` / `ae_import_media_from_url`.

## Architecture

| Piece | What it is |
|---|---|
| `src/index.ts` | Streamable-HTTP MCP server. `/mcp` (bearer auth), `/health` (open). Binds **127.0.0.1 only** — never port-forward this port. |
| `src/tools/premiere.ts` | 35 curated Premiere Pro tools (ExtendScript via the CEP bridge). |
| `src/tools/aftereffects.ts` | 23 curated After Effects tools (ScriptUI panel bridge + `aerender.exe`). |
| `cep/premiere/` | CEP panel ("MCP Bridge") — adapted from `hetpatel-11/Adobe_Premiere_Pro_MCP` (MIT). |
| `cep/aftereffects/mcp-bridge-auto.jsx` | ScriptUI panel ("MCP Bridge Auto") — adapted from `Dakkshin/after-effects-mcp` (MIT), plus `importFootage` / `saveProject` commands. |
| `scripts/install-windows.ps1` | Windows installer: Node, deps, panels, PlayerDebugMode, token, logon task, cloudflared. |

See `THIRD-PARTY-NOTICES.md` for upstream attribution.

## Quick start (on the Windows PC)

**Prerequisites:** Windows 10/11, Premiere Pro + After Effects installed, Adobe CC
signed in, PC set to never sleep (see below).

1. **Clone + install** (PowerShell, from the repo root):
   ```powershell
   .\scripts\install-windows.ps1
   ```
   With a Cloudflare Tunnel token for remote access:
   ```powershell
   .\scripts\install-windows.ps1 -TunnelToken "<token>" -PublicHostname "mcp.example.com"
   ```
   The installer: installs Node 20+ (winget) if needed, `npm install` + build,
   copies both bridge panels, enables `PlayerDebugMode`, creates the bridge
   folders, generates `PREMIERE_MCP_TOKEN` in `.env`, and registers a logon
   scheduled task so the server starts with Windows.

2. **Open the bridge panels** (once per Adobe app launch):
   - Premiere: `Window > Extensions > MCP Bridge` (bridge starts automatically).
   - After Effects: `Window > MCP Bridge Auto.jsx` — keep **auto-run ON**.

3. **Connect your AI client.** Give it:
   - the public MCP URL: `https://<your-host>/mcp`
   - the bearer token from the repo's `.env` (`PREMIERE_MCP_TOKEN`)

4. **Run the live remote test** (in this order):
   1. `verify_premiere_connection` → `connected: true`
   2. `import_media_from_url` with a generated clip URL → returns a local path
   3. `create_sequence` + `add_to_timeline` → clip on the timeline
   4. `export_sequence` → MP4 on disk
   5. (AE) `ae_verify_connection` → `ae_create_composition` → `ae_import_media_from_url` → `ae_render_comp`

**Meta Muse (recommended):** PremierePilot is being submitted to the public
connector platform at [muse.ai/platform](https://muse.ai/platform) as an
"Existing MCP" connector. Until it's listed, connect today via Muse's
custom-connector path (paste your server URL in chat — about a minute, no
review). A bundled skill also ships in `~/workspace/skills/premiere-mcp/`
(`SKILL.md`), whose CLI posts JSON-RPC to the public URL with
`Authorization: Bearer <PREMIERE_MCP_TOKEN>`.

**ChatGPT:** there is no public app-directory path for a self-hosted product
(OpenAI's directory requires one fixed URL for all users; every user runs their
own server). ChatGPT users connect via **developer-mode manual setup**: paid
plan → Settings → enable Developer mode → chatgpt.com/plugins → **+** → paste
your server URL → choose OAuth → create. The server speaks OAuth 2.1 with
Dynamic Client Registration, so ChatGPT registers itself, you approve the
scopes on the owner's consent page, and it connects — no token to copy.

**Claude:** connects through a custom connector with OAuth
(`https://claude.ai/api/mcp/auth_callback` is an allowed redirect).

Any other client that can send an `Authorization: Bearer` header works with the
current build.

## Authentication (OAuth 2.1)

The server co-hosts its own authorization server — no third-party identity
provider, no accounts. Two ways to authenticate:

| Method | Identity in audit log | Scope |
|---|---|---|
| `PREMIERE_MCP_TOKEN` bearer (single-user fallback) | `owner:bearer` | `admin` (everything) |
| OAuth 2.1 access token (ChatGPT / Claude connector) | `oauth:<client_id>` | granted at consent time |

**Endpoints**

| Endpoint | Purpose |
|---|---|
| `GET /.well-known/oauth-protected-resource` (+ `/mcp` variant) | RFC 9728 discovery — unauthenticated `/mcp` answers 401 with `WWW-Authenticate: … resource_metadata="<this URL>"`, which is what makes ChatGPT/Claude offer sign-in |
| `GET /.well-known/oauth-authorization-server` (+ `/.well-known/openid-configuration` alias) | RFC 8414 authorization-server metadata, served dynamically so the issuer matches the tunnel origin |
| `POST /register` | RFC 7591 Dynamic Client Registration — public clients only (no secrets); redirect URIs are validated against a strict allow-list |
| `GET /authorize` | Validates the request (client, redirect URI, PKCE S256 challenge) and renders the owner consent page |
| `POST /token` | `authorization_code` + `refresh_token` grants |
| `POST /revoke` | RFC 7009 revocation (always 200) |

**How ChatGPT / Claude connect.** Paste your public server URL (the tunnel
hostname) as the MCP server URL and pick OAuth. The client discovers the
metadata, registers via DCR (or presents a client-ID metadata document —
supported), and opens `/authorize`. You (the owner) enter the owner passphrase
and approve the requested scopes on the consent page; the client receives an
authorization code (PKCE S256, single-use, 10 min) and trades it for tokens.

**Scope model.** Every tool requires a scope, derived from its MCP annotations:

| Scope | Grants |
|---|---|
| `read` | read-only tools (project info, clip properties, catalog search) |
| `write` | non-destructive edits (timeline edits, imports, effects, exports) |
| `admin` | destructive tools + raw ExtendScript (`execute_extendscript` is admin, always) |
| `offline_access` | permission to issue refresh tokens (30 days; access tokens last 1 h) |

ChatGPT requests `mcp` + `offline_access` by default: `mcp` is treated as
read + write (never admin). A token lacking the required scope gets an
`insufficient_scope` tool error (audited).

**Revocation.** `POST /revoke` with a refresh token kills its whole family
(access tokens included). Refresh tokens rotate on every use: presenting an
already-rotated token is treated as replay and revokes the entire family.

**Owner passphrase.** `PREMIERE_MCP_OWNER_SECRET` gates the consent page. If
unset, the server generates one on first start, stores it 0600 in the server
home dir, and prints it to the console once. Rotate it by setting the env var
(or deleting the stored file and restarting). The static
`PREMIERE_MCP_TOKEN` keeps working as the admin fallback regardless.

**Token storage.** Clients, codes, and tokens live in
`<server-home>/oauth.json` (hashes only — raw secrets are never stored), mode
0600. Server home: `PREMIERE_MCP_HOME`, else `%APPDATA%\PremierePilot` on
Windows, `~/.premiere-mcp-server` elsewhere. Set `PREMIERE_MCP_PUBLIC_URL`
(e.g. `https://mcp.example.com`) so the OAuth issuer is stable; it also
allow-lists the tunnel hostname through the server's Host validation.

## Configuration (`.env`)

| Var | Required | Default |
|---|---|---|
| `PREMIERE_MCP_TOKEN` | yes (min 16 chars) | — generated by installer |
| `PORT` | no | `8787` |
| `PREMIERE_MCP_ASSETS` | no | `C:\Shotbyx\AI_Clips` (Windows) |
| `PREMIERE_TEMP_DIR` | no | `%TEMP%\premiere-mcp-bridge` (must match the CEP panel setting) |
| `AE_TEMP_DIR` | no | `%USERPROFILE%\Documents\ae-mcp-bridge` (must match the .jsx panel) |
| `PREMIERE_MCP_AUDIT` | no | `<assets-dir>/../audit.jsonl` |
| `PREMIERE_MCP_PUBLIC_URL` | no (strongly recommended) | — e.g. `https://mcp.example.com`; OAuth issuer + Host allow-list |
| `PREMIERE_MCP_HOME` | no | `%APPDATA%\PremierePilot` (Windows) / `~/.premiere-mcp-server` |
| `PREMIERE_MCP_OWNER_SECRET` | no | — generated once on first start if unset |

Copy `.env.example` to `.env` and fill in the token.

## Keeping the remote rig healthy

- **Power:** Settings → System → Power → *never* sleep on AC. A sleeping PC kills the tunnel and both apps.
- **Adobe sign-in:** stay signed in to Creative Cloud; sign-out popups wedge the bridge.
- **Interactive session:** Premiere/AE must run in a logged-in desktop session (RDP counts). No headless operation — Adobe apps need a GUI.
- **Modal dialogs** are the #1 unattended failure mode. A native dialog (missing media, save prompts, plugin errors) wedges the bridge until a human dismisses it. Run `probe_modal_dialog` when tools start timing out; the tool tells you exactly what to dismiss. Prefer workflows that avoid dialogs: relink media first, disable "show save dialog" style prompts, keep plugins licensed.

## Audit log

Every tool call is appended to `audit.jsonl` (JSONL): timestamp, caller, tool,
argument summary, outcome. Tokens and large/base64 payloads are redacted.

## Tool catalog

36 Premiere tools: connection + auto-launch, modal probe, version/project info,
`create_project`, open/save, project items + bins, `import_media`,
`import_media_from_url`, sequences (list/activate/create), timeline insert /
overwrite / trim / move / split / remove, playhead, markers, `detect_beats`
(BPM + beat-grid, optional one-call beat markers), effects +
transitions (QE DOM), keyframes, audio levels/mute, MOGRT text overlays, AME
export, frame export, raw ExtendScript escape hatch, and `search_tools`.

23 AE tools: connection probe, project/comp/layer info, create comp/text/shape/
solid/camera, layer properties (single + batch), duplicate/delete layer,
keyframes, expressions, effects + templates, `import_footage`,
`import_media_from_url`, `save_project`, `ae_render_comp` (aerender), raw
command escape hatch.

## Beat detection

`detect_beats` analyzes an audio file **on the Windows PC** and returns BPM, beat
times (seconds, ms precision), and a 0..1 confidence score — pure TypeScript DSP
(ffmpeg decode → spectral-flux onsets → autocorrelation tempo → beat-grid snap →
time-domain transient refinement), no extra installs beyond ffmpeg (the installer
adds it via winget).

With `writeMarkers: true` the beats are also written to the active sequence as
`"Beat N"` markers in a single bridge call — no per-marker round-trips.

Typical "cut to the beat" flow:

1. `detect_beats` with `audioPath: "C:\\Music\\track.mp3"`, `writeMarkers: true`
   → e.g. `{ bpm: 96, beatCount: 214, beats: [0.496, 1.12, ...], confidence: 0.96 }`
2. `split_clip` at each beat time on the video track to razor the footage on the music.
3. Optional: `add_transition` / `trim_clip` between the new segments, then
   `export_sequence` via Media Encoder.

Tip: point `audioPath` at the song file in your project assets. Long songs take a
few seconds to analyze; the tool runs locally, so no audio ever leaves the PC.

## Roadmap

- ~~OAuth 2.1 + Dynamic Client Registration~~ — shipped (see Authentication above).
- UXP panel port when Adobe stabilizes Premiere's UXP scripting surface.
- Program-monitor screenshot tool (frame export exists today).

## License

MIT — see `LICENSE`. Upstream bridge code is MIT with its own copyright —
see `THIRD-PARTY-NOTICES.md`.
