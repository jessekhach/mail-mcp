import { getCookie, unpackState, urls } from "@/lib/oauth";

// The mail server's login lands here; hand its code (or error) back to the app unchanged,
// but only in the browser that started this sign-in.
export function GET(req: Request) {
  const p = new URL(req.url).searchParams;
  const state = unpackState(p.get("state"));
  const cookie = state && `mcp_flow_${state.n}`;
  if (!state || !cookie || getCookie(req, cookie) !== "1") {
    return new Response("This sign-in expired or was started elsewhere. Start connecting again from your app.", {
      status: 400,
    });
  }

  const back = new URL(state.r);
  for (const key of ["code", "error", "error_description"]) {
    const v = p.get(key);
    if (v) back.searchParams.set(key, v);
  }
  if (state.s) back.searchParams.set("state", state.s);
  back.searchParams.set("iss", urls(req).issuer);
  return new Response(null, {
    status: 302,
    headers: {
      Location: back.toString(),
      "Set-Cookie": `${cookie}=; Path=/oauth/callback; Max-Age=0; HttpOnly; Secure; SameSite=Lax`,
    },
  });
}
