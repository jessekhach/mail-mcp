import { isValidRedirect } from "@/lib/oauth";

// Dynamic client registration for clients that don't use a metadata document. Nothing is
// stored: the authorize endpoint checks the redirect URI on every call and asks for consent
// before signing in for an app it doesn't know.
export async function POST(req: Request) {
  const meta = await req.json().catch(() => ({}));
  const redirects: string[] = Array.isArray(meta.redirect_uris) ? meta.redirect_uris : [];
  if (!redirects.length || !redirects.every((r) => isValidRedirect(r))) {
    return Response.json({ error: "invalid_redirect_uri" }, { status: 400 });
  }
  return Response.json(
    {
      ...meta,
      client_id: crypto.randomUUID(),
      client_id_issued_at: Math.floor(Date.now() / 1000),
      token_endpoint_auth_method: "none",
    },
    { status: 201 },
  );
}
