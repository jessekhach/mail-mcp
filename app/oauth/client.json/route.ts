import { urls } from "@/lib/oauth";

// The connector's identity at the mail server (OAuth Client ID Metadata Document).
export function GET(req: Request) {
  const { clientId, callback } = urls(req);
  return Response.json(
    {
      client_id: clientId,
      client_name: "mail-mcp",
      logo_uri: `${new URL(clientId).origin}/icon.png`,
      redirect_uris: [callback],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    },
    { headers: { "Cache-Control": "max-age=300" } },
  );
}
