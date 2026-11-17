// Minimal JMAP client (RFC 8620 core, RFC 8621 mail). Every call uses the caller's own
// OAuth access token from the JMAP server, so this connector stores no credentials.

const USING = [
  "urn:ietf:params:jmap:core",
  "urn:ietf:params:jmap:mail",
  "urn:ietf:params:jmap:submission",
];

export type Session = {
  apiUrl: string;
  accountId: string;
  username: string;
};

type Call = [method: string, args: Record<string, unknown>, id: string];

const sessions = new Map<string, { session: Session; at: number }>();
const SESSION_TTL_MS = 5 * 60_000;

export function sessionUrl(): string {
  const url = process.env.JMAP_SESSION_URL;
  if (!url) throw new Error("JMAP_SESSION_URL is not set");
  return url;
}

/** Fetches the JMAP session for a token. Returns null when the server rejects the token. */
export async function getSession(token: string): Promise<Session | null> {
  const cached = sessions.get(token);
  if (cached && Date.now() - cached.at < SESSION_TTL_MS) return cached.session;

  const res = await fetch(sessionUrl(), {
    headers: { Authorization: `Bearer ${token}` },
    cache: "no-store",
  });
  if (!res.ok) return null;
  const data = await res.json();
  const accountId = data.primaryAccounts?.["urn:ietf:params:jmap:mail"];
  if (!accountId || !data.apiUrl) return null;

  const session = { apiUrl: data.apiUrl, accountId, username: data.username };
  sessions.set(token, { session, at: Date.now() });
  return session;
}

export class JmapError extends Error {}

/** Runs method calls and returns each response's arguments keyed by call id. */
export async function call(
  token: string,
  session: Session,
  calls: Call[],
): Promise<Record<string, any>> {
  const res = await fetch(session.apiUrl, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ using: USING, methodCalls: calls }),
    cache: "no-store",
  });
  if (!res.ok) throw new JmapError(`JMAP server returned HTTP ${res.status}`);
  const data = await res.json();

  const out: Record<string, any> = {};
  for (const [name, args, id] of data.methodResponses as Call[]) {
    if (name === "error") {
      throw new JmapError(`${id}: ${String(args.type)} ${String(args.description ?? "")}`.trim());
    }
    out[id] = args;
  }
  return out;
}

export type Address = { name?: string | null; email: string };

/** Accepts "Name <a@b.com>" or "a@b.com". */
export function parseAddress(input: string): Address {
  const m = input.match(/^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/);
  if (m) return { name: m[1].trim() || null, email: m[2].trim() };
  return { email: input.trim() };
}

export function formatAddresses(list?: Address[] | null): string {
  return (list ?? []).map((a) => (a.name ? `${a.name} <${a.email}>` : a.email)).join(", ");
}
