import { describeRedirect } from "./oauth";

const esc = (v: string) =>
  v.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

/** Shown before signing in for an app that isn't Claude, ChatGPT or on this computer. */
export function consentPage(p: URLSearchParams, redirect: string): Response {
  const nonce = crypto.randomUUID();
  const who = esc(describeRedirect(redirect));

  const cancel = new URL(redirect);
  cancel.searchParams.set("error", "access_denied");
  if (p.get("state")) cancel.searchParams.set("state", p.get("state")!);

  const hidden = [...p.entries()]
    .filter(([k]) => k !== "consent")
    .map(([k, v]) => `<input type="hidden" name="${esc(k)}" value="${esc(v)}">`)
    .join("");

  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Allow access to your mail?</title><link rel="icon" href="/favicon.ico">
<style>
:root{color-scheme:light dark;--bg:#f5f5f7;--card:#fff;--text:#1d1d1f;--muted:#6e6e73;--accent:#4f46e5;--line:#d2d2d7}
@media (prefers-color-scheme:dark){:root{--bg:#000;--card:#1c1c1e;--text:#f5f5f7;--muted:#98989d;--accent:#7c83ff;--line:#38383a}}
body{margin:0;min-height:100vh;display:grid;place-items:center;background:var(--bg);color:var(--text);font:16px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
main{background:var(--card);border-radius:20px;padding:32px;max-width:380px;margin:16px;text-align:center}
img{width:64px;height:64px}h1{font-size:20px;margin:16px 0 8px}p{color:var(--muted);margin:0 0 24px}
strong{color:var(--text);word-break:break-all}
button,a{display:block;width:100%;box-sizing:border-box;padding:12px;border-radius:12px;font:inherit;font-weight:600;text-decoration:none;cursor:pointer}
button{background:var(--accent);color:#fff;border:0;margin-bottom:8px}a{color:var(--text);border:1px solid var(--line)}
</style></head><body><main>
<img src="/icon.png" alt="">
<h1>Allow access to your mail?</h1>
<p><strong>${who}</strong> wants to read, send and delete your email, and read and change your calendars and contacts. You'll sign in on your mail server next.</p>
<form method="post" action="/oauth/authorize">${hidden}<input type="hidden" name="consent" value="${nonce}">
<button type="submit">Continue</button></form>
<a href="${esc(cancel.toString())}">Cancel</a>
</main></body></html>`;

  return new Response(html, {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Set-Cookie": `mcp_consent=${nonce}; Path=/oauth/authorize; Max-Age=600; HttpOnly; Secure; SameSite=Strict`,
      "Content-Security-Policy": "frame-ancestors 'none'",
      "X-Frame-Options": "DENY",
      "Cache-Control": "no-store",
    },
  });
}
