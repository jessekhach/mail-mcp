import { isAllowedRedirect, packState, upstreamEndpoints, urls, UPSTREAM_SCOPE } from "@/lib/oauth";

export async function GET(req: Request) {
  const p = new URL(req.url).searchParams;
  const redirect = p.get("redirect_uri");
  if (!isAllowedRedirect(redirect)) {
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

  const { clientId, callback } = urls(req);
  const login = new URL((await upstreamEndpoints()).authorization_endpoint);
  login.search = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: callback,
    scope: UPSTREAM_SCOPE,
    code_challenge: challenge,
    code_challenge_method: "S256",
    state: packState(redirect, p.get("state")),
  }).toString();
  return Response.redirect(login, 302);
}
