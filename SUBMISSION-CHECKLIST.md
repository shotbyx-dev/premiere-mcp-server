# PremierePilot — Submission & Launch Checklist
**Product:** PremierePilot by Shotbyx · **Repo:** `shotbyx-dev/premiere-mcp-server`
**Created by Shotbyx.** Last updated 2026-09-26.

This checklist covers everything that needs a human (accounts, purchases, reviews).
Everything buildable without a login is already done and in this repo.

---

## A. Meta — public connector listing (PRIMARY distribution)

Submit at **https://muse.ai/platform** → "Existing MCP" connector.

### Ready in repo (no action needed)
- [x] Hosted MCP endpoint: streamable HTTP `POST /mcp` (public HTTPS via tunnel)
- [x] Auth: **OAuth 2.1 + PKCE (S256)** with Dynamic Client Registration + CIMD —
      exactly what the submission form expects (`src/oauth/`)
- [x] Product website: `site/` (GitHub Pages-ready)
- [x] Privacy policy URL: `site/privacy.html`
- [x] Terms of service URL: `site/terms.html`
- [x] Icon: `site/assets/icon-512.png` (512×512 PNG)
- [x] Example prompts (use these in the form):
      1. "Open my project 'Summer Recap' and list the bins in the media pool."
      2. "Lay these clips on the timeline in order and add the song underneath."
      3. "Cut the montage to the beat of the song."
      4. "Add a cross dissolve between every clip and export to C:\Exports\cut.mp4."
      5. "Take this still and generate a 5-second video from it, then import it."
      6. "In After Effects, make a 5-second title card that says 'SUMMER 2026'."
- [x] Security docs: `docs/SECURITY.md` (capability surface, audit log, revocation)
- [x] Access requirements text (paste into the form): "Requires a Windows 10/11 PC
      with Adobe Premiere Pro (and/or After Effects) installed, running the free
      PremierePilot server. The user's own PC stays powered on with Premiere open."

### Needs the user (Shotbyx)
- [ ] **Sign in** at muse.ai/platform with a **work/company email** (not personal)
- [ ] Fill the form: connector name **"PremierePilot"**, developer **Shotbyx**,
      product website (your Pages URL), support email/URL
- [ ] Upload `site/assets/icon-512.png`
- [ ] Connection type: **Existing MCP** → endpoint `https://<your-tunnel-host>/mcp`
      (use YOUR public URL from `pair.ps1`)
- [ ] Authentication: **OAuth with PKCE**
- [ ] Paste privacy policy + terms URLs (your Pages URLs + `/privacy.html`, `/terms.html`)
- [ ] Agree to the Muse Connector Terms; confirm you're authorized + own the brand assets
- [ ] Submit → wait for review (functional, security, legal + end-to-end testing;
      timelines undisclosed — platform opened Sept 18, 2026 with 1,500+ applications)
- [ ] **Before submitting, do the live verification below** — reviewers will test it

### Live verification (do this first — reviewers will too)
- [ ] On the Windows PC: installer run, Premiere + AE panels live, tunnel up,
      `PREMIERE_MCP_PUBLIC_URL` set (installer does this from `-PublicHostname`)
- [ ] From a phone browser (off the PC's network): open
      `https://<your-host>/.well-known/oauth-protected-resource` → JSON with
      `authorization_servers`
- [ ] In Muse: "connect my PremierePilot server at https://<your-host>/mcp" →
      complete OAuth sign-in → run: "verify the Premiere connection" and
      "list the sequences in the open project"
- [ ] Revoke the test client (`POST /revoke`) and confirm access stops

---

## B. ChatGPT — developer-mode distribution (no public listing possible)

**Do NOT attempt a public directory submission:** OpenAI's plugin directory
requires one fixed Universal URL for all users; every user self-hosts
PremierePilot on their own PC, so it cannot qualify (template URLs are gated
to trusted developers). Distribution = per-user developer-mode setup.

### User-side guide (already written)
- [x] Step-by-step in `docs/USER-GUIDE.md` (Option B): paid ChatGPT plan →
      Settings → enable Developer mode → chatgpt.com/plugins → **+** →
      paste server URL → choose **OAuth** → create → enable per chat.
- [ ] Sanity-check the guide against the live ChatGPT UI before sharing widely
      (developer-mode UI is beta and shifts).

### If OpenAI ever opens self-hosted listings
Requirements would be: Universal URL + domain verification
(`/.well-known/openai-apps-challenge`), tool annotations with justifications
(already on every tool), 5 positive + 3 negative test cases (web + mobile),
verified identity. Revisit only if OpenAI changes the URL policy.

---

## C. Launch prerequisites (all need the user)

- [ ] **Domain** (~$10/yr): needed for a stable public URL + OAuth issuer.
      Point it at the Cloudflare tunnel (installer takes `-PublicHostname`).
- [ ] **Cloudflare account + tunnel token**: `install-windows.ps1 -TunnelToken … -PublicHostname …`
- [ ] **GitHub Pages**: enable Pages on the repo (Settings → Pages → deploy from
      `main` / `site/`) so the website + privacy/terms URLs are live for the
      Meta submission.
- [ ] **Windows live run-through**: the installer + OAuth flow have never run on
      real Windows in this environment (Linux sandbox). Do one full pass:
      install → pair → tunnel → Muse connect → edit → export, and file any bugs.
- [ ] **Decide the business model** (free / paid / freemium) before the Meta
      submission asks "does the connector accept payments".

## D. Deliberately deferred
- Hosted relay for a ChatGPT public-directory listing (major architecture change;
  revisit only with real demand).
- ChatGPT Apps SDK custom UI widgets (`_meta["openai/outputTemplate"]`) — optional.
- macOS support (Premiere/AE bridges are Windows-first today).
