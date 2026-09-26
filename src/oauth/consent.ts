/**
 * The OAuth consent page rendered by GET /authorize and re-rendered by
 * POST /authorize on errors.
 *
 * Two gates before any code is issued:
 *  1. The owner passphrase (PREMIERE_MCP_OWNER_SECRET, or the generated one
 *     printed at first startup) — proves the human at the keyboard owns this
 *     Premiere instance.
 *  2. Explicit Approve / Deny — the owner sees the client name and every
 *     requested scope in plain language first.
 */
import { scopeDescription } from './scopes.js';

export interface ConsentFields {
  client_id: string;
  redirect_uri: string;
  scope: string;
  state: string;
  code_challenge: string;
  code_challenge_method: string;
  resource: string;
}

export interface ConsentPageArgs {
  fields: ConsentFields;
  clientName: string;
  scopes: string[];
  /** Shown when PREMIERE_MCP_PUBLIC_URL is not configured. */
  publicUrlWarning: boolean;
  error?: string;
}

function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function renderConsentPage(args: ConsentPageArgs): string {
  const f = args.fields;
  const hidden = (name: keyof ConsentFields) =>
    `<input type="hidden" name="${name}" value="${esc(f[name])}">`;
  const scopeItems = args.scopes
    .map(
      (s) =>
        `<li><strong>${esc(s)}</strong> — ${esc(scopeDescription(s))}</li>`
    )
    .join('\n');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Authorize PremierePilot access</title>
<style>
  body { font-family: system-ui, -apple-system, sans-serif; background: #0b0b0f; color: #eee;
         display: flex; justify-content: center; padding: 40px 16px; margin: 0; }
  .card { max-width: 520px; width: 100%; background: #14141b; border: 1px solid #2a2a35;
          border-radius: 12px; padding: 28px; }
  h1 { font-size: 20px; margin: 0 0 8px; }
  p { color: #b9b9c7; font-size: 14px; line-height: 1.5; }
  ul { font-size: 14px; color: #d7d7e2; line-height: 1.7; padding-left: 20px; }
  .warn { background: #3a2b00; border: 1px solid #8a6d00; border-radius: 8px;
          padding: 10px 12px; font-size: 13px; color: #ffd97a; margin: 12px 0; }
  .err { background: #3a0d0d; border: 1px solid #8a1f1f; border-radius: 8px;
         padding: 10px 12px; font-size: 13px; color: #ff9d9d; margin: 12px 0; }
  label { display: block; font-size: 13px; color: #b9b9c7; margin: 14px 0 6px; }
  input[type=password] { width: 100%; box-sizing: border-box; padding: 10px 12px; font-size: 15px;
    background: #0b0b0f; border: 1px solid #2a2a35; border-radius: 8px; color: #eee; }
  .row { display: flex; gap: 12px; margin-top: 18px; }
  button { flex: 1; padding: 12px; font-size: 15px; border-radius: 8px; cursor: pointer; border: 0; }
  .approve { background: #e10600; color: #fff; font-weight: 600; }
  .deny { background: transparent; color: #b9b9c7; border: 1px solid #2a2a35; }
  .meta { font-size: 12px; color: #77778a; margin-top: 16px; word-break: break-all; }
</style>
</head>
<body>
<div class="card">
  <h1>Authorize &ldquo;${esc(args.clientName)}&rdquo;?</h1>
  <p>This app wants to control <strong>PremierePilot</strong> (your Premiere Pro / After Effects
  remote) with the following permissions:</p>
  <ul>${scopeItems}</ul>
  ${args.publicUrlWarning ? `<div class="warn">Warning: PREMIERE_MCP_PUBLIC_URL is not configured. Tokens issued now are bound to this request's host; set the public URL for a stable setup.</div>` : ''}
  ${args.error ? `<div class="err">${esc(args.error)}</div>` : ''}
  <form method="post" action="/authorize">
    ${hidden('client_id')}
    ${hidden('redirect_uri')}
    ${hidden('scope')}
    ${hidden('state')}
    ${hidden('code_challenge')}
    ${hidden('code_challenge_method')}
    ${hidden('resource')}
    <label for="passphrase">Owner passphrase (proves you own this machine)</label>
    <input type="password" id="passphrase" name="passphrase" autocomplete="off" required>
    <div class="row">
      <button class="deny" type="submit" name="action" value="deny" formnovalidate>Deny</button>
      <button class="approve" type="submit" name="action" value="approve">Approve</button>
    </div>
  </form>
  <div class="meta">client_id: ${esc(f.client_id)}<br>redirect: ${esc(f.redirect_uri)}</div>
</div>
</body>
</html>`;
}

/** Minimal error page for authorize failures that must NOT redirect (bad client / redirect_uri). */
export function renderAuthorizeErrorPage(message: string): string {
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><title>Authorization error</title>
<style>body{font-family:system-ui,sans-serif;background:#0b0b0f;color:#eee;display:flex;justify-content:center;padding:40px 16px;margin:0}
.card{max-width:520px;background:#14141b;border:1px solid #2a2a35;border-radius:12px;padding:28px}</style>
</head><body><div class="card"><h1>Authorization error</h1><p>${esc(message)}</p>
<p>No code was issued. Close this tab and try connecting again.</p></div></body></html>`;
}
