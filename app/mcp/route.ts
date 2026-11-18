import { createMcpHandler, withMcpAuth } from "mcp-handler";
import { registerTools } from "@/lib/tools";
import { registerCalendarTools } from "@/lib/calendar";
import { registerContactTools } from "@/lib/contacts";
import { registerFilterTools } from "@/lib/filters";
import { getSession } from "@/lib/jmap";
import { ICON_DATA_URI } from "@/lib/icon";

// mcp-handler types serverInfo as name + version only, but hands the object to the SDK
// as is, which supports title and icons.
const serverInfo = {
  name: "jmap-mail",
  title: "Mail",
  version: "0.3.0",
  icons: [{ src: ICON_DATA_URI, mimeType: "image/png", sizes: ["64x64"] }],
};
const handler = createMcpHandler(
  (server) => {
    registerTools(server);
    registerCalendarTools(server);
    registerContactTools(server);
    registerFilterTools(server);
  },
  { serverInfo },
);

// A token is valid if the JMAP server accepts it. Nothing is stored here.
async function verifyToken(_req: Request, token?: string) {
  if (!token) return undefined;
  const session = await getSession(token);
  if (!session) return undefined;
  return { token, clientId: "jmap", scopes: [], extra: { username: session.username } };
}

const authed = withMcpAuth(handler, verifyToken, {
  required: true,
  resourceMetadataPath: "/.well-known/oauth-protected-resource/mcp",
});

export { authed as GET, authed as POST, authed as DELETE };
