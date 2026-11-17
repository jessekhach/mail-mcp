import { consentPage } from "@/lib/consent";
import {
  getCookie,
  isTrustedRedirect,
  isValidRedirect,
  packState,
  upstreamEndpoints,
  urls,
  UPSTREAM_SCOPE,
} from "@/lib/oauth";

export async function GET(req: Request) {
  const p = new URL(req.url).searchParams;
  return authorize(req, p, isTrustedRedirect(p.get("redirect_uri")));
}

// The consent page posts back here. The nonce must match the cookie set with the page, so
// another site can't submit the form on your behalf.
export async function POST(req: Request) {
  const p = new URLSearchParams(await req.text());
  const nonce = p.get("consent");
  if (!nonce || getCookie(req, "mcp_consent") !== nonce) {
    return new Response("This approval expired. Start connecting again from your app.", { status: 400 });
  }
  return authorize(req, p, true);
}

async function authorize(req: Request, p: URLSearchParams, approved: boolean) {
  const redirect = p.get("redirect_uri");
  if (!isValidRedirect(redirect)) {
    return new Response("redirect_uri is not allowed", { status: 400 });
  }

  const challenge = p.get("code_challenge");
  if (p.get("response_type") !== "code" || !challenge || p.get("code_challenge_method") !== "S256") {
    const back = new URL(redirect);
    back.searchParams.set("error", "invalid_request");
    back.searchParams.set("error_description", "Authorization code flow with S256 PKCE is required");
    if (p.get("state")) back.searchParams.set("state", p.get("state")!);
    return Response.redirect(back, 302);
  }

  if (!approved) return consentPage(p, redirect);

  const { clientId, callback } = urls(req);
  const n = crypto.randomUUID();
  const login = new URL((await upstreamEndpoints()).authorization_endpoint);
  login.search = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: callback,
    scope: UPSTREAM_SCOPE,
    code_challenge: challenge,
    code_challenge_method: "S256",
    state: packState({ r: redirect, s: p.get("state"), n }),
  }).toString();

  return new Response(null, {
    status: 303,
    headers: {
      Location: login.toString(),
      "Set-Cookie": `mcp_flow_${n}=1; Path=/oauth/callback; Max-Age=900; HttpOnly; Secure; SameSite=Lax`,
    },
  });
}
