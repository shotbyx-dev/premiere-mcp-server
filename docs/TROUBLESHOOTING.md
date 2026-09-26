# PremierePilot — Troubleshooting

**PremierePilot by Shotbyx.** Most problems fall into a handful of buckets:
app/panel not running, a modal dialog wedging the bridge, auth, tunnel, or
ffmpeg. Work top-down.

---

## Premiere Pro not detected

`verify_premiere_connection` returns `connected: false` (or times out).

1. Is **Premiere Pro actually open**? The bridge talks to a running app, not an
   installed one.
2. Is the panel open? **Window > Extensions > MCP Bridge** — the bridge starts
   automatically once the panel is visible. Try closing and reopening the panel.
3. Is the **server** running? It starts at Windows logon via the scheduled task
   the installer created. Check Task Scheduler for the PremierePilot task, or
   run `node dist/index.js` from the repo to start it manually and watch the logs.
4. Does `PREMIERE_TEMP_DIR` in `.env` match the folder the CEP panel is actually
   using? The two sides communicate through a file queue in that folder — a
   mismatch means silence on both ends.

## Bridge panel not loading (Premiere)

If **Window > Extensions** doesn't list *MCP Bridge* at all:

1. The installer enables `PlayerDebugMode` (CSXS 9–15) so unsigned panels load —
   re-run `.\scripts\install-windows.ps1` if you installed the panel manually.
2. Confirm the panel files landed in the CEP extensions folder
   (`%APPDATA%\Adobe\CEP\extensions\`).
3. Restart Premiere Pro after (re)installing the panel.

## Modal dialog wedged the bridge — the #1 unattended failure

**Symptom:** tools that used to work start timing out; the app looks open but
nothing responds.

**Cause:** a native dialog is waiting for a human — missing media, a save
prompt, a plugin license error, an Adobe sign-in popup.

**Fix:**

1. Run `probe_modal_dialog` — it tells you exactly what to dismiss.
2. Look at the PC's screen (or RDP in) and dismiss the dialog yourself.
3. Prefer dialog-free workflows going forward: relink media first, disable
   "show save dialog"-style prompts, keep plugins licensed, and stay signed in
   to Creative Cloud.

## Bearer token rejected (401)

1. The client must send `Authorization: Bearer <token>` — exact header, no
   extra whitespace.
2. Confirm the token matches `PREMIERE_MCP_TOKEN` in the repo's `.env`
   (min 16 chars).
3. If you rotated the token, update **every** paired client — old tokens die
   instantly.
4. Hitting `/health` (open, no auth) should still answer — if even that fails,
   the problem is the server/tunnel, not the token.

## Tunnel URL changed / unreachable from outside

1. `/health` works locally (`http://127.0.0.1:8787/health`) but the public URL
   doesn't → the problem is `cloudflared`, not the server. Check the Windows
   service status for the tunnel.
2. If your tunnel hostname changed, update the URL in every AI client to the
   new `https://<your-host>/mcp`. The token is unchanged.
3. Re-running the installer with a fresh `-TunnelToken` / `-PublicHostname`
   re-registers the tunnel cleanly.

## ffmpeg missing

`detect_beats` (and anything else shelling out to ffmpeg) fails with "not found".

- The installer adds ffmpeg via `winget install --id Gyan.FFmpeg -e`. Re-run the
  installer, or install it manually and make sure `ffmpeg` is on `PATH`, then
  restart the server.
- Note: beat detection analyzes audio **on your PC** — no audio ever leaves the
  machine. Long tracks take a few seconds; that's normal.

## After Effects panel issues

1. The panel lives at **Window > MCP Bridge Auto.jsx** (not under Extensions).
   Keep **auto-run ON** so the bridge polls the file queue.
2. `AE_TEMP_DIR` in `.env` must match the folder the `.jsx` panel uses
   (default `%USERPROFILE%\Documents\ae-mcp-bridge`). Mismatch = silence.
3. `ae_verify_connection` is the AE equivalent of the Premiere connection check —
   start there.
4. `ae_render_comp` shells out to `aerender.exe`; if renders fail, verify AE's
   render engine is installed and the comp name matches exactly.

## CI badge is red

The README's CI badge reflects the **main** branch's latest workflow run.

1. Open the repo's **Actions** tab and read the failing step's log — don't guess.
2. Common causes: an SDK package name changed, a dependency broke the build, or a
   committed workflow edit had a syntax error.
3. Fix on a branch, push, and confirm the run goes green before merging —
   the badge flips back on its own.
