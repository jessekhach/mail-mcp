import { getPublicOrigin } from "mcp-handler";
import { sessionUrl } from "./jmap";

// The connector is its own OAuth authorization server for MCP clients and a client of the
// mail server. Clients never talk to the mail server's OAuth directly, because Claude (for
// one) asks for every scope the server advertises and for a token audience the server won't
// issue. The client's PKCE challenge is passed through to the mail server, which verifies
// it, so nothing here needs storage or a secret.

export const UPSTREAM_SCOPE = "offline_access urn:ietf:params:oauth:scope:mail";

const TRUSTED_REDIRECTS = [
  "https://claude.ai/api/mcp/auth_callback",
  "https://claude.com/api/mcp/auth_callback",
  "https://chatgpt.com/connector_platform_oauth_redirect",
];

const LOOPBACK = ["localhost", "127.0.0.1", "[::1]"];
const UNSAFE_SCHEMES = ["javascript:", "data:", "file:", "vbscript:", "blob:", "about:"];

function parse(uri: string | null): URL | null {
  try {
    return uri ? new URL(uri) : null;
  } catch {
    return null;
  }
}

/** Any https callback, a loopback address, or an app's own URL scheme. */
export function isValidRedirect(uri: string | null): uri is string {
  const u = parse(uri);
  if (!u || u.hash) return false;
  if (u.protocol === "https:") return true;
  if (u.protocol === "http:") return LOOPBACK.includes(u.hostname);
  return !UNSAFE_SCHEMES.includes(u.protocol);
}

/** Callbacks that skip the connector's own consent page. */
export function isTrustedRedirect(uri: string | null): boolean {
  const u = parse(uri);
  if (!u || !isValidRedirect(uri)) return false;
  if (TRUSTED_REDIRECTS.includes(uri!)) return true;
  if (u.origin === "https://chatgpt.com" && u.pathname.startsWith("/connector/oauth/")) return true;
  return u.protocol === "http:";
}

/** Who receives the sign-in, in words for the consent page. */
export function describeRedirect(uri: string): string {
  const u = new URL(uri);
  if (u.protocol === "https:") return u.host;
  return `the app that opens ${u.protocol}// links`;
}

export function getCookie(req: Request, name: string): string | undefined {
  for (const part of (req.headers.get("cookie") ?? "").split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return v.join("=");
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

// The client's redirect and state ride through the mail server's login inside its state.
// `n` matches a cookie set in the browser that started the sign-in, so a login link built
// by someone else can't deliver a code to a redirect of their choosing.
type FlowState = { r: string; s: string | null; n: string };

export function packState(v: FlowState): string {
  return Buffer.from(JSON.stringify(v)).toString("base64url");
}

export function unpackState(packed: string | null): FlowState | null {
  try {
    const v = JSON.parse(Buffer.from(packed ?? "", "base64url").toString());
    return isValidRedirect(v.r) && typeof v.n === "string" ? v : null;
  } catch {
    return null;
  }
}
