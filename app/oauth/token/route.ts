import { upstreamEndpoints, urls } from "@/lib/oauth";

// Swaps in the connector's own client id and callback, then relays to the mail server.
// The mail server checks Claude's PKCE verifier and issues the tokens Claude will use.
export async function POST(req: Request) {
  const p = new URLSearchParams(await req.text());
  const { clientId, callback } = urls(req);
  const grant = p.get("grant_type");

  const body = new URLSearchParams({ grant_type: grant ?? "", client_id: clientId });
  if (grant === "authorization_code") {
    body.set("code", p.get("code") ?? "");
    body.set("code_verifier", p.get("code_verifier") ?? "");
    body.set("redirect_uri", callback);
  } else if (grant === "refresh_token") {
    body.set("refresh_token", p.get("refresh_token") ?? "");
  } else {
    return Response.json({ error: "unsupported_grant_type" }, { status: 400 });
  }

  const res = await fetch((await upstreamEndpoints()).token_endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body,
    cache: "no-store",
  });
  const data = await res.json();
  delete data.id_token;
  return Response.json(data, { status: res.status, headers: { "Cache-Control": "no-store" } });
}
