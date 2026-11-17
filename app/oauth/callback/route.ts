import { unpackState, urls } from "@/lib/oauth";

// The mail server's login lands here; hand its code (or error) back to Claude unchanged.
export function GET(req: Request) {
  const p = new URL(req.url).searchParams;
  const state = unpackState(p.get("state"));
  if (!state) return new Response("Invalid state", { status: 400 });

  const back = new URL(state.r);
  for (const key of ["code", "error", "error_description"]) {
    const v = p.get(key);
    if (v) back.searchParams.set(key, v);
  }
  if (state.s) back.searchParams.set("state", state.s);
  back.searchParams.set("iss", urls(req).issuer);
  return Response.redirect(back, 302);
}
