import { generateProtectedResourceMetadata, getPublicOrigin, metadataCorsOptionsRequestHandler } from "mcp-handler";

// RFC 9728: the connector is its own authorization server (see lib/oauth.ts), which sends
// users on to the mail server's login page.
export function GET(req: Request) {
  const origin = getPublicOrigin(req);
  const body = generateProtectedResourceMetadata({
    authServerUrls: [origin],
    resourceUrl: `${origin}/mcp`,
    additionalMetadata: { scopes_supported: ["mail"] },
  });
  return Response.json(body, { headers: { "Access-Control-Allow-Origin": "*", "Cache-Control": "max-age=60" } });
}

export const OPTIONS = metadataCorsOptionsRequestHandler();
