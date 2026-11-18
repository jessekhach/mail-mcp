import { metadataCorsOptionsRequestHandler } from "mcp-handler";
import { urls } from "@/lib/oauth";

export function GET(req: Request) {
  const { issuer } = urls(req);
  return Response.json(
    {
      issuer,
      authorization_endpoint: `${issuer}/oauth/authorize`,
      token_endpoint: `${issuer}/oauth/token`,
      registration_endpoint: `${issuer}/oauth/register`,
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none"],
      scopes_supported: ["mail", "calendars", "contacts"],
      client_id_metadata_document_supported: true,
    },
    { headers: { "Access-Control-Allow-Origin": "*", "Cache-Control": "max-age=60" } },
  );
}

export const OPTIONS = metadataCorsOptionsRequestHandler();
