import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/server";
import { call, CONTACTS, type Session } from "./jmap";
import { auth, reply, type Ctx } from "./tools";

// Contacts are JSContact cards (RFC 9553) over JMAP (RFC 9610).

type AddressBook = { id: string; name: string; isDefault?: boolean };

function accountId(s: Session): string {
  if (!s.contactsAccountId) throw new Error("No contacts access. Disconnect and reconnect the connector to grant it.");
  return s.contactsAccountId;
}

const run = (token: string, s: Session, calls: [string, Record<string, unknown>, string][]) => call(token, s, calls, CONTACTS);

async function getAddressBooks(token: string, s: Session): Promise<AddressBook[]> {
  const r = await run(token, s, [["AddressBook/get", { accountId: accountId(s), properties: ["id", "name", "isDefault"] }, "b"]]);
  return r.b.list;
}

function findBook(list: AddressBook[], ref?: string): AddressBook {
  const lc = ref?.trim().toLowerCase();
  const found = ref ? list.find((b) => b.id === ref) ?? list.find((b) => b.name.toLowerCase() === lc) : list.find((b) => b.isDefault) ?? list[0];
  if (!found) throw new Error(ref ? `No address book "${ref}". Available: ${list.map((b) => b.name).join(", ")}` : "This account has no address books.");
  return found;
}

const values = (m: any, key: string): string[] => (Object.values(m ?? {}) as any[]).map((v) => v[key]).filter(Boolean);

function fullName(c: any): string {
  if (c.name?.full) return c.name.full;
  const parts = (c.name?.components ?? []) as { kind: string; value: string }[];
  const pick = (k: string) => parts.filter((p) => p.kind === k).map((p) => p.value);
  return [...pick("title"), ...pick("given"), ...pick("given2"), ...pick("surname"), ...pick("surname2"), ...pick("credential")].join(" ") || (Object.values(c.nicknames ?? {}) as any[])[0]?.name || "";
}

function summarize(c: any) {
  return {
    id: c.id,
    name: fullName(c) || undefined,
    organization: values(c.organizations, "name").join("; ") || undefined,
    emails: values(c.emails, "address"),
    phones: values(c.phones, "number"),
  };
}

function formatAddress(a: any): string {
  if (a.full) return a.full;
  return ((a.components ?? []) as any[]).map((p) => p.value).filter((v) => v && v.trim()).join(" ");
}

const keyed = (list: string[], prefix: string, make: (v: string) => object) =>
  Object.fromEntries(list.map((v, i) => [`${prefix}${i + 1}`, make(v.trim())]));

const fields = {
  first_name: z.string().optional(),
  last_name: z.string().optional(),
  organization: z.string().optional(),
  job_title: z.string().optional(),
  emails: z.array(z.string()).optional(),
  phones: z.array(z.string()).optional(),
  addresses: z.array(z.string()).optional().describe("Postal addresses, one string each"),
  birthday: z.string().optional().describe("YYYY-MM-DD"),
  note: z.string().optional(),
};

/** Turns tool arguments into JSContact properties. List fields replace what's there. */
function cardFields(a: { [K in keyof typeof fields]?: any }, existingName?: any) {
  const out: Record<string, unknown> = {};
  if (a.first_name !== undefined || a.last_name !== undefined) {
    const old = (existingName?.components ?? []) as { kind: string; value: string }[];
    const given = a.first_name ?? old.find((p) => p.kind === "given")?.value;
    const surname = a.last_name ?? old.find((p) => p.kind === "surname")?.value;
    const components = [given && { kind: "given", value: given }, surname && { kind: "surname", value: surname }].filter(Boolean);
    out.name = { components, full: [given, surname].filter(Boolean).join(" ") };
  }
  if (a.organization !== undefined) out.organizations = a.organization ? { o1: { name: a.organization } } : null;
  if (a.job_title !== undefined) out.titles = a.job_title ? { t1: { name: a.job_title, kind: "title" } } : null;
  if (a.emails) out.emails = keyed(a.emails, "e", (address) => ({ address }));
  if (a.phones) out.phones = keyed(a.phones, "p", (number) => ({ number }));
  if (a.addresses) out.addresses = keyed(a.addresses, "a", (full) => ({ full }));
  if (a.birthday !== undefined) {
    const m = a.birthday.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (a.birthday && !m) throw new Error("birthday must be YYYY-MM-DD.");
    out.anniversaries = m ? { b1: { kind: "birth", date: { "@type": "PartialDate", year: +m[1], month: +m[2], day: +m[3] } } } : null;
  }
  if (a.note !== undefined) out.notes = a.note ? { n1: { note: a.note } } : null;
  return out;
}

export function registerContactTools(server: McpServer) {
  server.registerTool(
    "search_contacts",
    {
      title: "Search contacts",
      description: "Finds contacts by name, email, phone, company or any text, sorted by name. Returns summaries; use get_contact for everything on the card.",
      inputSchema: z.object({
        query: z.string().optional().describe("Matches any field. Omit to list contacts"),
        address_book: z.string().optional(),
        limit: z.number().int().min(1).max(200).default(25),
        offset: z.number().int().min(0).default(0),
      }),
      annotations: { readOnlyHint: true },
    },
    async (a, ctx) => {
      const { token, session } = await auth(ctx as Ctx);
      const acct = accountId(session);
      const filter: Record<string, unknown> = {};
      if (a.query) filter.text = a.query;
      if (a.address_book) filter.inAddressBook = findBook(await getAddressBooks(token, session), a.address_book).id;
      const r = await run(token, session, [
        ["ContactCard/query", { accountId: acct, filter, calculateTotal: true }, "q"],
        ["ContactCard/get", { accountId: acct, "#ids": { resultOf: "q", name: "ContactCard/query", path: "/ids" }, properties: ["id", "name", "nicknames", "organizations", "emails", "phones"] }, "g"],
      ]);
      // The server sorts only by date, so sort by name here. Address books are small.
      const all = r.g.list.map(summarize).sort((x: any, y: any) => (x.name ?? "").localeCompare(y.name ?? ""));
      return reply({ total: r.q.total, offset: a.offset, results: all.slice(a.offset, a.offset + a.limit) });
    },
  );

  server.registerTool(
    "get_contact",
    {
      title: "Read contact",
      description: "Returns everything on one contact card.",
      inputSchema: z.object({ id: z.string() }),
      annotations: { readOnlyHint: true },
    },
    async ({ id }, ctx) => {
      const { token, session } = await auth(ctx as Ctx);
      const r = await run(token, session, [["ContactCard/get", { accountId: accountId(session), ids: [id] }, "g"]]);
      const c = r.g.list[0];
      if (!c) throw new Error(`No contact with id ${id}`);
      const bday = (Object.values(c.anniversaries ?? {}) as any[]).find((x) => x.kind === "birth")?.date;
      return reply({
        ...summarize(c),
        nickname: values(c.nicknames, "name").join(", ") || undefined,
        jobTitle: values(c.titles, "name").join("; ") || undefined,
        addresses: (Object.values(c.addresses ?? {}) as any[]).map(formatAddress).filter(Boolean),
        websites: (Object.values(c.links ?? {}) as any[]).map((l) => l.uri),
        birthday: bday?.year || bday?.month ? [bday.year ?? "--", String(bday.month ?? "").padStart(2, "0"), String(bday.day ?? "").padStart(2, "0")].join("-") : bday?.utc,
        notes: values(c.notes, "note").join("\n\n") || undefined,
        hasPhoto: c.media ? (Object.values(c.media) as any[]).some((m) => m.kind === "photo") : undefined,
      });
    },
  );

  server.registerTool(
    "create_contact",
    {
      title: "Create contact",
      description: "Adds a contact to the default address book unless another is named.",
      inputSchema: z.object({ ...fields, address_book: z.string().optional() }),
      annotations: { destructiveHint: false },
    },
    async (a, ctx) => {
      const { token, session } = await auth(ctx as Ctx);
      const book = findBook(await getAddressBooks(token, session), a.address_book);
      const card = { "@type": "Card", version: "1.0", kind: a.first_name || a.last_name ? "individual" : "org", addressBookIds: { [book.id]: true }, ...cardFields(a) };
      if (!a.first_name && !a.last_name && !a.organization) throw new Error("Give a first name, last name or organization.");
      const r = await run(token, session, [["ContactCard/set", { accountId: accountId(session), create: { c: card } }, "s"]]);
      if (r.s.notCreated?.c) throw new Error(`The server refused the contact: ${JSON.stringify(r.s.notCreated.c)}`);
      return reply({ created: true, id: r.s.created.c.id, addressBook: book.name });
    },
  );

  server.registerTool(
    "update_contact",
    {
      title: "Update contact",
      description: "Changes a contact. Only the fields you pass change; emails, phones and addresses replace the existing list, so include the ones to keep. An empty string clears a text field.",
      inputSchema: z.object({ id: z.string(), ...fields }),
      annotations: { destructiveHint: false, idempotentHint: true },
    },
    async ({ id, ...a }, ctx) => {
      const { token, session } = await auth(ctx as Ctx);
      const acct = accountId(session);
      let name;
      if (a.first_name !== undefined || a.last_name !== undefined) {
        const r0 = await run(token, session, [["ContactCard/get", { accountId: acct, ids: [id], properties: ["name"] }, "g"]]);
        if (!r0.g.list[0]) throw new Error(`No contact with id ${id}`);
        name = r0.g.list[0].name;
      }
      const patch = cardFields(a, name);
      if (!Object.keys(patch).length) throw new Error("Nothing to change.");
      const r = await run(token, session, [["ContactCard/set", { accountId: acct, update: { [id]: patch } }, "s"]]);
      if (r.s.notUpdated?.[id]) throw new Error(`The server refused the change: ${JSON.stringify(r.s.notUpdated[id])}`);
      return reply({ updated: true, id, changed: Object.keys(patch) });
    },
  );

  server.registerTool(
    "delete_contacts",
    {
      title: "Delete contacts",
      description: "Deletes contacts. This can't be undone.",
      inputSchema: z.object({ ids: z.array(z.string()).min(1) }),
      annotations: { destructiveHint: true },
    },
    async ({ ids }, ctx) => {
      const { token, session } = await auth(ctx as Ctx);
      const r = await run(token, session, [["ContactCard/set", { accountId: accountId(session), destroy: ids }, "d"]]);
      return reply({ deleted: (r.d.destroyed ?? []).length, failed: r.d.notDestroyed });
    },
  );
}
