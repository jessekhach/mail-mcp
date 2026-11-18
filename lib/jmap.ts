// Minimal JMAP client (RFC 8620 core, RFC 8621 mail, RFC 9610 contacts, JMAP calendars).
// Every call uses the caller's own OAuth access token from the JMAP server, so this
// connector stores no credentials.

const CORE = "urn:ietf:params:jmap:core";
export const MAIL = [CORE, "urn:ietf:params:jmap:mail", "urn:ietf:params:jmap:submission"];
export const CALENDARS = [CORE, "urn:ietf:params:jmap:calendars"];
export const CONTACTS = [CORE, "urn:ietf:params:jmap:contacts"];
export const SIEVE = [CORE, "urn:ietf:params:jmap:sieve"];

export type Session = {
  apiUrl: string;
  downloadUrl: string;
  uploadUrl: string;
  accountId: string;
  // Absent when the token was granted before the connector asked for these scopes.
  calendarAccountId?: string;
  contactsAccountId?: string;
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

  const session = {
    apiUrl: data.apiUrl,
    downloadUrl: data.downloadUrl,
    uploadUrl: data.uploadUrl,
    accountId,
    calendarAccountId: data.primaryAccounts?.["urn:ietf:params:jmap:calendars"],
    contactsAccountId: data.primaryAccounts?.["urn:ietf:params:jmap:contacts"],
    username: data.username,
  };
  sessions.set(token, { session, at: Date.now() });
  return session;
}

export class JmapError extends Error {}

/** Runs method calls and returns each response's arguments keyed by call id. */
export async function call(
  token: string,
  session: Session,
  calls: Call[],
  using: string[] = MAIL,
): Promise<Record<string, any>> {
  const res = await fetch(session.apiUrl, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ using, methodCalls: calls }),
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

const fill = (template: string, vars: Record<string, string>) =>
  template.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? encodeURIComponent(vars[k]) : m));

/** Uploads bytes and returns the blob id (RFC 8620 section 6.1). */
export async function upload(token: string, s: Session, data: Uint8Array, type: string, accountId = s.accountId): Promise<string> {
  const res = await fetch(fill(s.uploadUrl, { accountId }), {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": type },
    body: data as BodyInit,
  });
  if (!res.ok) throw new JmapError(`Upload failed with HTTP ${res.status}`);
  return (await res.json()).blobId;
}

export async function download(token: string, s: Session, blobId: string, name: string, type: string): Promise<Uint8Array> {
  const res = await fetch(fill(s.downloadUrl, { accountId: s.accountId, blobId, name, type }), {
    headers: { Authorization: `Bearer ${token}` },
    cache: "no-store",
  });
  if (!res.ok) throw new JmapError(`Download failed with HTTP ${res.status}`);
  return new Uint8Array(await res.arrayBuffer());
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
