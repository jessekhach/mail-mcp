import { getPublicOrigin } from "mcp-handler";
import { sessionUrl } from "./jmap";

// The connector is its own OAuth authorization server for Claude and a client of the mail
// server. Claude never talks to the mail server's OAuth directly, because it asks for every
// scope the server advertises and for a token audience the server won't issue. Claude's
// PKCE challenge is passed through to the mail server, which verifies it, so nothing here
// needs storage or a secret.

export const UPSTREAM_SCOPE = "offline_access urn:ietf:params:oauth:scope:mail";

const ALLOWED_REDIRECTS = [
  "https://claude.ai/api/mcp/auth_callback",
  "https://claude.com/api/mcp/auth_callback",
];

/** Claude's web callbacks, or a loopback address (Claude Code and desktop clients). */
export function isAllowedRedirect(uri: string | null): uri is string {
  if (!uri) return false;
  if (ALLOWED_REDIRECTS.includes(uri)) return true;
  try {
    const u = new URL(uri);
    return u.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname);
  } catch {
    return false;
  }
}

export function urls(req: Request) {
  const origin = getPublicOrigin(req);
  return {
    issuer: origin,
    clientId: `${origin}/oauth/client.json`,
    callback: `${origin}/oauth/callback`,
  };
}

let upstream: { authorization_endpoint: string; token_endpoint: string } | undefined;

export async function upstreamEndpoints() {
  if (!upstream) {
    const origin = new URL(sessionUrl()).origin;
    const res = await fetch(`${origin}/.well-known/oauth-authorization-server`, { cache: "no-store" });
    if (!res.ok) throw new Error(`Mail server OAuth metadata returned HTTP ${res.status}`);
    upstream = await res.json();
  }
  return upstream!;
}

/** Claude's redirect and state ride through the mail server's login inside its state. */
export function packState(redirect: string, state: string | null): string {
  return Buffer.from(JSON.stringify({ r: redirect, s: state })).toString("base64url");
}

export function unpackState(packed: string | null): { r: string; s: string | null } | null {
  try {
    const v = JSON.parse(Buffer.from(packed ?? "", "base64url").toString());
    return isAllowedRedirect(v.r) ? v : null;
  } catch {
    return null;
  }
}
