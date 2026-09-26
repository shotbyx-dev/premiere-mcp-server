# PremierePilot site/

GitHub Pages-ready marketing site for **PremierePilot by Shotbyx**. Pure static HTML/CSS/JS — no build step, works from `file://`.

## Contents

| File | What it is |
|---|---|
| `index.html` | Landing page: hero with animated chat demo, how-it-works, capability cards, security/trust, install guide, FAQ |
| `styles.css` | Dark cinematic styling |
| `script.js` | Chat-demo animation + WebMCP tool registration (see below) |
| `privacy.html` / `terms.html` | Privacy policy and terms of service |
| `assets/icon-512.png` | Product icon (also used for the Muse connector submission) |
| `.well-known/webmcp` | WebMCP manifest — machine-readable tool index for browser agents |

## Deploy

Enable GitHub Pages on the repo (`Settings → Pages → Deploy from branch → main → /site`) and the site goes live at `https://shotbyx-dev.github.io/premiere-mcp-server/`.

## Agent-ready: WebMCP (early adopter)

This site speaks [WebMCP](https://webmachinelearning.github.io/webmcp/) — the W3C Web Machine Learning Community Group draft for websites exposing tools to AI agents via `modelContext`. It does **not** change the product architecture: the MCP server that drives Premiere Pro / After Effects remains the core product. This is just the marketing site being agent-readable too.

### What's implemented

1. **One imperative tool** (`site/script.js`): `getPremierePilotOverview` — a read-only (`annotations.readOnlyHint: true`) tool returning install steps, supported AI clients, pricing, and links as structured text. Registration is guarded by feature detection:
   ```js
   var modelContext =
     (typeof document !== "undefined" && document.modelContext) ||
     (typeof navigator !== "undefined" && navigator.modelContext) ||
     null;
   ```
   Both entry points are checked because the spec moved from `navigator.modelContext` to `document.modelContext` in May 2026 (Chromium 150 deprecates the `navigator` form). No polyfill is used — if the API is absent, the page behaves identically.
2. **`.well-known/webmcp` manifest**: a JSON index at the domain root so agents can discover the site's tools before loading any page.

### Deliberately skipped: declarative form annotations

The declarative WebMCP API (`toolname` / `tooldescription` / `toolparamtitle` / `toolautosubmit` attributes) only annotates real `<form>` elements — and this static page has **none**. Rather than ship a fake, non-functional form, no declarative annotations exist yet. When a real form lands on the site (e.g. a newsletter signup), it should carry `toolname` and `tooldescription` attributes, and it should be added to `.well-known/webmcp`.

### Status & verification

- WebMCP is a Community Group **draft** — origin trial / behind flags in Chrome 149+ and Edge; nothing in Safari/Firefox yet. Expect the API surface to keep shifting.
- Local testing: enable `chrome://flags/#enable-webmcp-testing`, then check `navigator.modelContext.getTools()` in DevTools on the page.
- Lighthouse has an informational "Registered WebMCP tools" audit that verifies registration.
- Re-check the tool object shape, declarative attributes, and permissions policy against the current spec before treating this as production-ready.
