import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/server";
import { call, download, getSession, upload, VACATION, parseAddress, formatAddresses, type Address, type Session } from "./jmap";

export type Ctx = { http?: { authInfo?: { token: string } } };
type Mailbox = { id: string; name: string; role: string | null; parentId: string | null; totalEmails: number; unreadEmails: number };
type Identity = { id: string; name: string; email: string };

export async function auth(ctx: Ctx) {
  const token = ctx.http?.authInfo?.token;
  if (!token) throw new Error("Not signed in to the mail server.");
  const session = await getSession(token);
  if (!session) throw new Error("The mail server rejected the session. Reconnect the connector.");
  return { token, session };
}

export const reply = (value: unknown) => ({
  content: [{ type: "text" as const, text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }],
});

async function getMailboxes(token: string, s: Session): Promise<Mailbox[]> {
  const r = await call(token, s, [["Mailbox/get", { accountId: s.accountId, properties: ["id", "name", "role", "parentId", "totalEmails", "unreadEmails"] }, "m"]]);
  return r.m.list;
}

export async function getIdentities(token: string, s: Session): Promise<Identity[]> {
  const r = await call(token, s, [["Identity/get", { accountId: s.accountId }, "i"]]);
  return r.i.list.map((i: Identity) => ({ id: i.id, name: i.name, email: i.email }));
}

/** Matches a mailbox by id, role (inbox, sent, drafts, trash, archive, junk) or name. */
function findMailbox(list: Mailbox[], ref: string): Mailbox {
  const lc = ref.trim().toLowerCase();
  const found =
    list.find((m) => m.id === ref) ??
    list.find((m) => m.role === lc) ??
    list.find((m) => m.name.toLowerCase() === lc) ??
    list.find((m) => m.role === { spam: "junk", deleted: "trash", bin: "trash" }[lc]);
  if (!found) throw new Error(`No mailbox "${ref}". Available: ${list.map((m) => m.name).join(", ")}`);
  return found;
}

function byRole(list: Mailbox[], role: string): Mailbox {
  const m = list.find((x) => x.role === role);
  if (!m) throw new Error(`The server has no ${role} mailbox.`);
  return m;
}

function pickIdentity(ids: Identity[], email: string | undefined, fallbackEmail: string): Identity {
  if (email) {
    const want = parseAddress(email).email.toLowerCase();
    const hit = ids.find((i) => i.email.toLowerCase() === want);
    if (!hit) throw new Error(`Can't send as ${want}. Sending addresses: ${ids.map((i) => i.email).join(", ")}`);
    return hit;
  }
  return ids.find((i) => i.email.toLowerCase() === fallbackEmail.toLowerCase()) ?? ids[0];
}

const SUMMARY = ["id", "threadId", "mailboxIds", "keywords", "from", "to", "cc", "subject", "receivedAt", "preview", "hasAttachment"];

function summarize(e: any, names: Record<string, string>) {
  return {
    id: e.id,
    threadId: e.threadId,
    date: e.receivedAt,
    from: formatAddresses(e.from),
    to: formatAddresses(e.to),
    cc: formatAddresses(e.cc) || undefined,
    subject: e.subject,
    preview: e.preview,
    unread: !e.keywords?.$seen,
    flagged: !!e.keywords?.$flagged,
    hasAttachment: e.hasAttachment,
    mailboxes: Object.keys(e.mailboxIds ?? {}).map((id) => names[id] ?? id),
  };
}

export const toDate = (d: string) => (/^\d{4}-\d{2}-\d{2}$/.test(d) ? `${d}T00:00:00Z` : new Date(d).toISOString());
const stripHtml = (h: string) => h.replace(/<style[\s\S]*?<\/style>|<script[\s\S]*?<\/script>/gi, "").replace(/<br\s*\/?>|<\/p>|<\/div>/gi, "\n").replace(/<[^>]+>/g, "").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/\n{3,}/g, "\n\n").trim();

function bodyText(e: any): string {
  const parts = (e.textBody?.length ? e.textBody : e.htmlBody) ?? [];
  const raw = parts.map((p: any) => e.bodyValues?.[p.partId]?.value ?? "").join("\n");
  return parts.some((p: any) => p.type === "text/html") ? stripHtml(raw) : raw;
}

type Compose = {
  identity: Identity;
  to: Address[];
  cc?: Address[];
  bcc?: Address[];
  subject: string;
  body: string;
  html?: string;
  inReplyTo?: string[];
  references?: string[];
  attachments?: Attachment[];
};

type Attachment = { blobId: string; type: string; name: string };

/** Creates the message in Drafts and, when send is true, submits it and moves it to Sent. */
async function compose(token: string, s: Session, c: Compose, send: boolean) {
  const boxes = await getMailboxes(token, s);
  const drafts = byRole(boxes, "drafts");
  const email: Record<string, unknown> = {
    mailboxIds: { [drafts.id]: true },
    keywords: { $draft: true, $seen: true },
    from: [{ name: c.identity.name, email: c.identity.email }],
    to: c.to,
    subject: c.subject,
    bodyValues: { text: { value: c.body }, ...(c.html ? { html: { value: c.html } } : {}) },
    textBody: [{ partId: "text", type: "text/plain" }],
    ...(c.html ? { htmlBody: [{ partId: "html", type: "text/html" }] } : {}),
    ...(c.cc?.length ? { cc: c.cc } : {}),
    ...(c.inReplyTo?.length ? { inReplyTo: c.inReplyTo, references: c.references } : {}),
    ...(c.attachments?.length ? { attachments: c.attachments.map((a) => ({ ...a, disposition: "attachment" })) } : {}),
  };
  const calls: [string, Record<string, unknown>, string][] = [["Email/set", { accountId: s.accountId, create: { draft: email } }, "e"]];
  if (send) {
    const sent = byRole(boxes, "sent");
    const rcpt = [...c.to, ...(c.cc ?? []), ...(c.bcc ?? [])].map((a) => ({ email: a.email }));
    calls.push([
      "EmailSubmission/set",
      {
        accountId: s.accountId,
        // Bcc goes only in the envelope, never in the headers.
        create: { sub: { identityId: c.identity.id, emailId: "#draft", envelope: { mailFrom: { email: c.identity.email }, rcptTo: rcpt } } },
        onSuccessUpdateEmail: { "#sub": { [`mailboxIds/${drafts.id}`]: null, [`mailboxIds/${sent.id}`]: true, "keywords/$draft": null } },
      },
      "s",
    ]);
  }
  const r = await call(token, s, calls);
  if (r.e.notCreated?.draft) throw new Error(`Couldn't create the message: ${JSON.stringify(r.e.notCreated.draft)}`);
  if (send && r.s.notCreated?.sub) throw new Error(`The server refused to send: ${JSON.stringify(r.s.notCreated.sub)}`);
  return { id: r.e.created.draft.id, from: `${c.identity.name} <${c.identity.email}>` };
}

const addressList = z.array(z.string()).describe('Addresses as "a@b.com" or "Name <a@b.com>"');

const attachmentInput = z
  .array(
    z.object({
      filename: z.string().optional().describe("Name for a new file, or the name of an attachment to reuse"),
      text: z.string().optional().describe("Content of a new text file (CSV, Markdown, .ics, ...)"),
      base64: z.string().optional().describe("Content of a new binary file, base64-encoded"),
      type: z.string().optional().describe("MIME type of a new file; guessed from the name if omitted"),
      from_email_id: z.string().optional().describe("Reuse an attachment from this email: the one named filename, or all of them"),
    }),
  )
  .optional()
  .describe("Files to attach: new content, or attachments from existing emails");

const MIME: Record<string, string> = { txt: "text/plain", md: "text/markdown", csv: "text/csv", html: "text/html", json: "application/json", ics: "text/calendar", pdf: "application/pdf", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", zip: "application/zip" };
const guessType = (name: string) => MIME[name.split(".").pop()?.toLowerCase() ?? ""] ?? "application/octet-stream";

async function emailAttachments(token: string, s: Session, emailId: string): Promise<Attachment[]> {
  const r = await call(token, s, [["Email/get", { accountId: s.accountId, ids: [emailId], properties: ["attachments"] }, "g"]]);
  const e = r.g.list[0];
  if (!e) throw new Error(`No email with id ${emailId}`);
  return (e.attachments ?? []).map((p: any, i: number) => ({ blobId: p.blobId, type: p.type, name: p.name ?? `attachment-${i + 1}` }));
}

async function resolveAttachments(token: string, s: Session, list: z.infer<typeof attachmentInput>): Promise<Attachment[]> {
  const out: Attachment[] = [];
  for (const a of list ?? []) {
    if (a.from_email_id) {
      const all = await emailAttachments(token, s, a.from_email_id);
      const pick = a.filename ? all.filter((x) => x.name === a.filename) : all;
      if (!pick.length) throw new Error(`Email ${a.from_email_id} has no attachment${a.filename ? ` named "${a.filename}"` : "s"}. It has: ${all.map((x) => x.name).join(", ") || "none"}`);
      out.push(...pick);
    } else {
      if (!a.filename || (a.text === undefined && a.base64 === undefined)) throw new Error("A new attachment needs filename and text or base64.");
      const type = a.type ?? guessType(a.filename);
      const bytes = a.text !== undefined ? new TextEncoder().encode(a.text) : Uint8Array.from(Buffer.from(a.base64!, "base64"));
      out.push({ blobId: await upload(token, s, bytes, type), type, name: a.filename });
    }
  }
  return out;
}

const READABLE_TEXT = /^(text\/|application\/(json|xml|csv|ics|javascript|x-yaml|yaml))/;

export function registerTools(server: McpServer) {
  server.registerTool(
    "list_mailboxes",
    {
      title: "List mailboxes",
      description: "Lists mail folders with their roles (inbox, sent, drafts, trash, archive, junk) and message counts.",
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true },
    },
    async (_args, ctx) => {
      const { token, session } = await auth(ctx as Ctx);
      return reply(await getMailboxes(token, session));
    },
  );

  server.registerTool(
    "list_identities",
    {
      title: "List sending addresses",
      description: "Lists the addresses this account can send from, with display names, signatures, Reply-To and automatic Bcc.",
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true },
    },
    async (_args, ctx) => {
      const { token, session } = await auth(ctx as Ctx);
      const r = await call(token, session, [["Identity/get", { accountId: session.accountId }, "i"]]);
      return reply(
        r.i.list.map((i: any) => ({
          id: i.id,
          name: i.name,
          email: i.email,
          replyTo: formatAddresses(i.replyTo) || undefined,
          bcc: formatAddresses(i.bcc) || undefined,
          textSignature: i.textSignature || undefined,
          htmlSignature: i.htmlSignature || undefined,
        })),
      );
    },
  );

  server.registerTool(
    "search_emails",
    {
      title: "Search email",
      description: "Searches mail, newest first. All filters combine with AND. Returns summaries; use get_email for the full message.",
      inputSchema: z.object({
        query: z.string().optional().describe("Full-text search across headers and body"),
        from: z.string().optional(),
        to: z.string().optional(),
        subject: z.string().optional(),
        mailbox: z.string().optional().describe("Mailbox name, role (inbox, sent, archive...) or id"),
        after: z.string().optional().describe("ISO date, e.g. 2026-11-01"),
        before: z.string().optional().describe("ISO date"),
        unread: z.boolean().optional(),
        flagged: z.boolean().optional(),
        has_attachment: z.boolean().optional(),
        limit: z.number().int().min(1).max(100).default(20),
        offset: z.number().int().min(0).default(0),
      }),
      annotations: { readOnlyHint: true },
    },
    async (a, ctx) => {
      const { token, session } = await auth(ctx as Ctx);
      const boxes = await getMailboxes(token, session);
      const names = Object.fromEntries(boxes.map((m) => [m.id, m.name]));
      const filter: Record<string, unknown> = {};
      if (a.query) filter.text = a.query;
      if (a.from) filter.from = a.from;
      if (a.to) filter.to = a.to;
      if (a.subject) filter.subject = a.subject;
      if (a.mailbox) filter.inMailbox = findMailbox(boxes, a.mailbox).id;
      if (a.after) filter.after = toDate(a.after);
      if (a.before) filter.before = toDate(a.before);
      if (a.unread !== undefined) filter[a.unread ? "notKeyword" : "hasKeyword"] = "$seen";
      if (a.flagged !== undefined) filter[a.flagged ? "hasKeyword" : "notKeyword"] = "$flagged";
      if (a.has_attachment !== undefined) filter.hasAttachment = a.has_attachment;
      const r = await call(token, session, [
        ["Email/query", { accountId: session.accountId, filter, sort: [{ property: "receivedAt", isAscending: false }], position: a.offset, limit: a.limit, calculateTotal: true }, "q"],
        ["Email/get", { accountId: session.accountId, "#ids": { resultOf: "q", name: "Email/query", path: "/ids" }, properties: SUMMARY }, "g"],
      ]);
      return reply({ total: r.q.total, offset: a.offset, results: r.g.list.map((e: any) => summarize(e, names)) });
    },
  );

  server.registerTool(
    "get_email",
    {
      title: "Read email",
      description: "Returns one message with headers, plain-text body (HTML converted to text) and its attachments. Use get_attachment to open one.",
      inputSchema: z.object({ id: z.string() }),
      annotations: { readOnlyHint: true },
    },
    async ({ id }, ctx) => {
      const { token, session } = await auth(ctx as Ctx);
      const boxes = await getMailboxes(token, session);
      const names = Object.fromEntries(boxes.map((m) => [m.id, m.name]));
      const r = await call(token, session, [[
        "Email/get",
        { accountId: session.accountId, ids: [id], properties: [...SUMMARY, "replyTo", "bcc", "sentAt", "messageId", "inReplyTo", "references", "textBody", "htmlBody", "attachments", "bodyValues"], fetchTextBodyValues: true, fetchHTMLBodyValues: true, maxBodyValueBytes: 200_000 },
        "g",
      ]]);
      const e = r.g.list[0];
      if (!e) throw new Error(`No email with id ${id}`);
      return reply({
        ...summarize(e, names),
        replyTo: formatAddresses(e.replyTo) || undefined,
        sentAt: e.sentAt,
        body: bodyText(e),
        attachments: (e.attachments ?? []).map((p: any, i: number) => ({ index: i, name: p.name, type: p.type, size: p.size })),
      });
    },
  );

  server.registerTool(
    "get_thread",
    {
      title: "Read conversation",
      description: "Returns every message in a conversation, oldest first, as summaries.",
      inputSchema: z.object({ thread_id: z.string() }),
      annotations: { readOnlyHint: true },
    },
    async ({ thread_id }, ctx) => {
      const { token, session } = await auth(ctx as Ctx);
      const boxes = await getMailboxes(token, session);
      const names = Object.fromEntries(boxes.map((m) => [m.id, m.name]));
      const r = await call(token, session, [
        ["Thread/get", { accountId: session.accountId, ids: [thread_id] }, "t"],
        ["Email/get", { accountId: session.accountId, "#ids": { resultOf: "t", name: "Thread/get", path: "/list/*/emailIds" }, properties: SUMMARY }, "g"],
      ]);
      return reply(r.g.list.map((e: any) => summarize(e, names)));
    },
  );

  const composeSchema = {
    from: z.string().optional().describe("Sending address; defaults to the account's main address. See list_identities."),
    to: addressList,
    cc: addressList.optional(),
    bcc: addressList.optional(),
    subject: z.string(),
    body: z.string().describe("Plain-text body"),
    html: z.string().optional().describe("Optional HTML version of the body"),
    attachments: attachmentInput,
  };

  server.registerTool(
    "send_email",
    {
      title: "Send email",
      description: "Composes and sends a new message. A copy is kept in Sent.",
      inputSchema: z.object(composeSchema),
      annotations: { destructiveHint: false, openWorldHint: true },
    },
    async (a, ctx) => {
      const { token, session } = await auth(ctx as Ctx);
      const identity = pickIdentity(await getIdentities(token, session), a.from, session.username);
      const res = await compose(token, session, { identity, to: a.to.map(parseAddress), cc: a.cc?.map(parseAddress), bcc: a.bcc?.map(parseAddress), subject: a.subject, body: a.body, html: a.html, attachments: await resolveAttachments(token, session, a.attachments) }, true);
      return reply({ sent: true, ...res });
    },
  );

  server.registerTool(
    "save_draft",
    {
      title: "Save draft",
      description: "Saves a message to Drafts without sending it, so it can be reviewed and sent from any mail app.",
      inputSchema: z.object({ ...composeSchema, to: addressList.default([]) }),
      annotations: { destructiveHint: false },
    },
    async (a, ctx) => {
      const { token, session } = await auth(ctx as Ctx);
      const identity = pickIdentity(await getIdentities(token, session), a.from, session.username);
      const res = await compose(token, session, { identity, to: a.to.map(parseAddress), cc: a.cc?.map(parseAddress), bcc: a.bcc?.map(parseAddress), subject: a.subject, body: a.body, html: a.html, attachments: await resolveAttachments(token, session, a.attachments) }, false);
      return reply({ draft: true, ...res });
    },
  );

  server.registerTool(
    "reply_to_email",
    {
      title: "Reply to email",
      description: "Replies to a message, threading it correctly and quoting the original. Sends from the address the original was sent to unless 'from' is given. Set send=false to save as a draft instead.",
      inputSchema: z.object({
        email_id: z.string(),
        body: z.string(),
        reply_all: z.boolean().default(false),
        from: z.string().optional(),
        quote_original: z.boolean().default(true),
        send: z.boolean().default(true),
        attachments: attachmentInput,
      }),
      annotations: { destructiveHint: false, openWorldHint: true },
    },
    async (a, ctx) => {
      const { token, session } = await auth(ctx as Ctx);
      const ids = await getIdentities(token, session);
      const r = await call(token, session, [[
        "Email/get",
        { accountId: session.accountId, ids: [a.email_id], properties: ["from", "replyTo", "to", "cc", "subject", "messageId", "references", "receivedAt", "textBody", "htmlBody", "bodyValues"], fetchTextBodyValues: true, fetchHTMLBodyValues: true, maxBodyValueBytes: 100_000 },
        "g",
      ]]);
      const o = r.g.list[0];
      if (!o) throw new Error(`No email with id ${a.email_id}`);

      const mine = new Set(ids.map((i) => i.email.toLowerCase()));
      const addressedTo = [...(o.to ?? []), ...(o.cc ?? [])] as Address[];
      const fromEmail = a.from ?? addressedTo.find((x) => mine.has(x.email.toLowerCase()))?.email;
      const identity = pickIdentity(ids, fromEmail, session.username);

      const to: Address[] = o.replyTo?.length ? o.replyTo : o.from ?? [];
      const toSet = new Set(to.map((x) => x.email.toLowerCase()));
      const cc = a.reply_all ? addressedTo.filter((x) => !mine.has(x.email.toLowerCase()) && !toSet.has(x.email.toLowerCase())) : [];
      const subject = /^re:/i.test(o.subject ?? "") ? o.subject : `Re: ${o.subject ?? ""}`;
      const quoted = a.quote_original
        ? `\n\nOn ${new Date(o.receivedAt).toUTCString()}, ${formatAddresses(o.from)} wrote:\n${bodyText(o).split("\n").map((l) => `> ${l}`).join("\n")}`
        : "";
      const res = await compose(
        token,
        session,
        { identity, to, cc, subject, body: a.body + quoted, inReplyTo: o.messageId ?? [], references: [...(o.references ?? []), ...(o.messageId ?? [])], attachments: await resolveAttachments(token, session, a.attachments) },
        a.send,
      );
      if (a.send) await call(token, session, [["Email/set", { accountId: session.accountId, update: { [a.email_id]: { "keywords/$answered": true } } }, "a"]]);
      return reply({ [a.send ? "sent" : "draft"]: true, to: formatAddresses(to), cc: formatAddresses(cc) || undefined, ...res });
    },
  );

  server.registerTool(
    "move_emails",
    {
      title: "Move email",
      description: "Moves messages to a mailbox (by name, role such as archive or inbox, or id).",
      inputSchema: z.object({ ids: z.array(z.string()).min(1), mailbox: z.string() }),
      annotations: { destructiveHint: false, idempotentHint: true },
    },
    async ({ ids, mailbox }, ctx) => {
      const { token, session } = await auth(ctx as Ctx);
      const target = findMailbox(await getMailboxes(token, session), mailbox);
      const r = await call(token, session, [["Email/set", { accountId: session.accountId, update: Object.fromEntries(ids.map((id) => [id, { mailboxIds: { [target.id]: true } }])) }, "u"]]);
      return reply({ moved: Object.keys(r.u.updated ?? {}).length, to: target.name, failed: r.u.notUpdated });
    },
  );

  server.registerTool(
    "update_emails",
    {
      title: "Mark email",
      description: "Marks messages read/unread and/or flagged/unflagged.",
      inputSchema: z.object({ ids: z.array(z.string()).min(1), read: z.boolean().optional(), flagged: z.boolean().optional() }),
      annotations: { destructiveHint: false, idempotentHint: true },
    },
    async ({ ids, read, flagged }, ctx) => {
      const { token, session } = await auth(ctx as Ctx);
      const patch: Record<string, true | null> = {};
      if (read !== undefined) patch["keywords/$seen"] = read ? true : null;
      if (flagged !== undefined) patch["keywords/$flagged"] = flagged ? true : null;
      if (!Object.keys(patch).length) throw new Error("Pass read and/or flagged.");
      const r = await call(token, session, [["Email/set", { accountId: session.accountId, update: Object.fromEntries(ids.map((id) => [id, patch])) }, "u"]]);
      return reply({ updated: Object.keys(r.u.updated ?? {}).length, failed: r.u.notUpdated });
    },
  );

  server.registerTool(
    "delete_emails",
    {
      title: "Delete email",
      description: "Moves messages to Trash. With permanent=true they are destroyed and cannot be recovered.",
      inputSchema: z.object({ ids: z.array(z.string()).min(1), permanent: z.boolean().default(false) }),
      annotations: { destructiveHint: true },
    },
    async ({ ids, permanent }, ctx) => {
      const { token, session } = await auth(ctx as Ctx);
      if (permanent) {
        const r = await call(token, session, [["Email/set", { accountId: session.accountId, destroy: ids }, "d"]]);
        return reply({ destroyed: (r.d.destroyed ?? []).length, failed: r.d.notDestroyed });
      }
      const trash = byRole(await getMailboxes(token, session), "trash");
      const r = await call(token, session, [["Email/set", { accountId: session.accountId, update: Object.fromEntries(ids.map((id) => [id, { mailboxIds: { [trash.id]: true } }])) }, "u"]]);
      return reply({ trashed: Object.keys(r.u.updated ?? {}).length, failed: r.u.notUpdated });
    },
  );

  server.registerTool(
    "get_attachment",
    {
      title: "Open attachment",
      description: "Returns an email attachment's content: text files as text, images as images, anything else (PDF, Office...) as a file. Pick it by index or name from get_email.",
      inputSchema: z.object({ email_id: z.string(), index: z.number().int().min(0).optional(), name: z.string().optional() }),
      annotations: { readOnlyHint: true },
    },
    async ({ email_id, index, name }, ctx) => {
      const { token, session } = await auth(ctx as Ctx);
      const all = await emailAttachments(token, session, email_id);
      const att = name !== undefined ? all.find((x) => x.name === name) : all[index ?? 0];
      if (!att) throw new Error(`No such attachment. This email has: ${all.map((x, i) => `${i}: ${x.name}`).join(", ") || "none"}`);
      const bytes = await download(token, session, att.blobId, att.name, att.type);
      const type = att.type.toLowerCase();
      if (READABLE_TEXT.test(type)) {
        const text = new TextDecoder().decode(bytes);
        return reply(type === "text/html" ? stripHtml(text) : text.slice(0, 500_000));
      }
      if (bytes.length > 15_000_000) throw new Error(`${att.name} is ${Math.round(bytes.length / 1e6)} MB, too large to open here.`);
      const data = Buffer.from(bytes).toString("base64");
      if (type.startsWith("image/")) return { content: [{ type: "image" as const, data, mimeType: att.type }] };
      return { content: [{ type: "resource" as const, resource: { uri: `attachment:///${encodeURIComponent(att.name)}`, mimeType: att.type, blob: data } }] };
    },
  );

  server.registerTool(
    "forward_email",
    {
      title: "Forward email",
      description: "Forwards a message with its attachments, adding your note above the original. Set send=false to save as a draft instead.",
      inputSchema: z.object({
        email_id: z.string(),
        to: addressList,
        cc: addressList.optional(),
        bcc: addressList.optional(),
        body: z.string().default("").describe("Your note above the forwarded message"),
        from: z.string().optional(),
        include_attachments: z.boolean().default(true),
        send: z.boolean().default(true),
      }),
      annotations: { destructiveHint: false, openWorldHint: true },
    },
    async (a, ctx) => {
      const { token, session } = await auth(ctx as Ctx);
      const ids = await getIdentities(token, session);
      const r = await call(token, session, [[
        "Email/get",
        { accountId: session.accountId, ids: [a.email_id], properties: ["from", "to", "cc", "subject", "sentAt", "receivedAt", "textBody", "htmlBody", "bodyValues", "attachments"], fetchTextBodyValues: true, fetchHTMLBodyValues: true, maxBodyValueBytes: 200_000 },
        "g",
      ]]);
      const o = r.g.list[0];
      if (!o) throw new Error(`No email with id ${a.email_id}`);
      const mine = new Set(ids.map((i) => i.email.toLowerCase()));
      const fromEmail = a.from ?? ([...(o.to ?? []), ...(o.cc ?? [])] as Address[]).find((x) => mine.has(x.email.toLowerCase()))?.email;
      const header = [
        "---------- Forwarded message ----------",
        `From: ${formatAddresses(o.from)}`,
        `Date: ${new Date(o.sentAt ?? o.receivedAt).toUTCString()}`,
        `Subject: ${o.subject ?? ""}`,
        `To: ${formatAddresses(o.to)}`,
        ...(o.cc?.length ? [`Cc: ${formatAddresses(o.cc)}`] : []),
      ].join("\n");
      const attachments: Attachment[] = a.include_attachments
        ? (o.attachments ?? []).map((p: any, i: number) => ({ blobId: p.blobId, type: p.type, name: p.name ?? `attachment-${i + 1}` }))
        : [];
      const res = await compose(
        token,
        session,
        {
          identity: pickIdentity(ids, fromEmail, session.username),
          to: a.to.map(parseAddress),
          cc: a.cc?.map(parseAddress),
          bcc: a.bcc?.map(parseAddress),
          subject: /^fwd?:/i.test(o.subject ?? "") ? o.subject : `Fwd: ${o.subject ?? ""}`,
          body: `${a.body ? `${a.body}\n\n` : ""}${header}\n\n${bodyText(o)}`,
          attachments,
        },
        a.send,
      );
      if (a.send) await call(token, session, [["Email/set", { accountId: session.accountId, update: { [a.email_id]: { "keywords/$forwarded": true } } }, "f"]]);
      return reply({ [a.send ? "sent" : "draft"]: true, attachments: attachments.length, ...res });
    },
  );

  server.registerTool(
    "create_mailbox",
    {
      title: "Create folder",
      description: "Creates a mail folder, optionally inside another one.",
      inputSchema: z.object({ name: z.string(), parent: z.string().optional().describe("Parent folder name, role or id") }),
      annotations: { destructiveHint: false },
    },
    async ({ name, parent }, ctx) => {
      const { token, session } = await auth(ctx as Ctx);
      const parentId = parent ? findMailbox(await getMailboxes(token, session), parent).id : null;
      const r = await call(token, session, [["Mailbox/set", { accountId: session.accountId, create: { m: { name, parentId } } }, "s"]]);
      if (r.s.notCreated?.m) throw new Error(`The server refused: ${JSON.stringify(r.s.notCreated.m)}`);
      return reply({ created: true, id: r.s.created.m.id, name });
    },
  );

  server.registerTool(
    "update_mailbox",
    {
      title: "Rename or move folder",
      description: "Renames a mail folder and/or moves it under another folder.",
      inputSchema: z.object({
        mailbox: z.string().describe("Folder name, role or id"),
        name: z.string().optional().describe("New name"),
        parent: z.string().optional().describe('New parent folder, or "" for the top level'),
      }),
      annotations: { destructiveHint: false, idempotentHint: true },
    },
    async (a, ctx) => {
      const { token, session } = await auth(ctx as Ctx);
      const boxes = await getMailboxes(token, session);
      const box = findMailbox(boxes, a.mailbox);
      const patch: Record<string, unknown> = {};
      if (a.name) patch.name = a.name;
      if (a.parent !== undefined) patch.parentId = a.parent === "" ? null : findMailbox(boxes, a.parent).id;
      if (!Object.keys(patch).length) throw new Error("Pass name and/or parent.");
      const r = await call(token, session, [["Mailbox/set", { accountId: session.accountId, update: { [box.id]: patch } }, "s"]]);
      if (r.s.notUpdated?.[box.id]) throw new Error(`The server refused: ${JSON.stringify(r.s.notUpdated[box.id])}`);
      return reply({ updated: true, id: box.id, ...patch });
    },
  );

  server.registerTool(
    "delete_mailbox",
    {
      title: "Delete folder",
      description: "Deletes a mail folder. If it still has messages, it is left alone unless delete_messages=true, which destroys every message that is only in that folder and can't be undone.",
      inputSchema: z.object({ mailbox: z.string(), delete_messages: z.boolean().default(false) }),
      annotations: { destructiveHint: true },
    },
    async ({ mailbox, delete_messages }, ctx) => {
      const { token, session } = await auth(ctx as Ctx);
      const box = findMailbox(await getMailboxes(token, session), mailbox);
      if (box.role) throw new Error(`${box.name} is the ${box.role} folder, which can't be deleted.`);
      const r = await call(token, session, [["Mailbox/set", { accountId: session.accountId, destroy: [box.id], onDestroyRemoveEmails: delete_messages }, "d"]]);
      const fail = r.d.notDestroyed?.[box.id];
      if (fail) {
        if (fail.type === "mailboxHasEmail") throw new Error(`${box.name} still has ${box.totalEmails} messages. Move them out, or pass delete_messages=true to destroy them.`);
        throw new Error(`The server refused: ${JSON.stringify(fail)}`);
      }
      return reply({ deleted: box.name });
    },
  );

  server.registerTool(
    "mark_spam",
    {
      title: "Mark as spam",
      description: "Marks messages as spam (moves them to Junk) or as not spam (moves them back to the Inbox).",
      inputSchema: z.object({ ids: z.array(z.string()).min(1), spam: z.boolean().default(true) }),
      annotations: { destructiveHint: false, idempotentHint: true },
    },
    async ({ ids, spam }, ctx) => {
      const { token, session } = await auth(ctx as Ctx);
      const target = byRole(await getMailboxes(token, session), spam ? "junk" : "inbox");
      const patch = { mailboxIds: { [target.id]: true }, "keywords/$junk": spam ? true : null, "keywords/$notjunk": spam ? null : true };
      const r = await call(token, session, [["Email/set", { accountId: session.accountId, update: Object.fromEntries(ids.map((id) => [id, patch])) }, "u"]]);
      return reply({ marked: Object.keys(r.u.updated ?? {}).length, as: spam ? "spam" : "not spam", movedTo: target.name, failed: r.u.notUpdated });
    },
  );

  server.registerTool(
    "update_identity",
    {
      title: "Edit sending address",
      description: "Changes the display name, signature, Reply-To or automatic Bcc of one of your sending addresses (see list_identities). Signatures are not added to messages sent through this connector.",
      inputSchema: z.object({
        identity: z.string().describe("The address, e.g. jesse@example.com, or its id"),
        name: z.string().optional().describe("Display name shown as the sender"),
        text_signature: z.string().optional().describe('Plain-text signature; "" removes it'),
        html_signature: z.string().optional().describe('HTML signature; "" removes it'),
        reply_to: addressList.optional().describe("Reply-To addresses; an empty list removes it"),
        bcc: addressList.optional().describe("Addresses always Bcc'd; an empty list removes it"),
      }),
      annotations: { destructiveHint: false, idempotentHint: true },
    },
    async (a, ctx) => {
      const { token, session } = await auth(ctx as Ctx);
      const ids = await getIdentities(token, session);
      const want = a.identity.trim().toLowerCase();
      const id = ids.find((i) => i.id === a.identity || i.email.toLowerCase() === want);
      if (!id) throw new Error(`No sending address "${a.identity}". Addresses: ${ids.map((i) => i.email).join(", ")}`);
      const patch: Record<string, unknown> = {};
      if (a.name !== undefined) patch.name = a.name;
      if (a.text_signature !== undefined) patch.textSignature = a.text_signature;
      if (a.html_signature !== undefined) patch.htmlSignature = a.html_signature;
      if (a.reply_to) patch.replyTo = a.reply_to.length ? a.reply_to.map(parseAddress) : null;
      if (a.bcc) patch.bcc = a.bcc.length ? a.bcc.map(parseAddress) : null;
      if (!Object.keys(patch).length) throw new Error("Nothing to change.");
      const r = await call(token, session, [["Identity/set", { accountId: session.accountId, update: { [id.id]: patch } }, "s"]]);
      if (r.s.notUpdated?.[id.id]) throw new Error(`The server refused: ${JSON.stringify(r.s.notUpdated[id.id])}`);
      return reply({ updated: id.email, changed: Object.keys(patch) });
    },
  );

  server.registerTool(
    "get_vacation_reply",
    {
      title: "Read auto-reply",
      description: "Shows whether the vacation auto-reply is on, its dates and its message.",
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true },
    },
    async (_args, ctx) => {
      const { token, session } = await auth(ctx as Ctx);
      const r = await call(token, session, [["VacationResponse/get", { accountId: session.accountId }, "v"]], VACATION);
      const v = r.v.list[0] ?? {};
      return reply({ enabled: !!v.isEnabled, from: v.fromDate, to: v.toDate, subject: v.subject, body: v.textBody ?? (v.htmlBody ? stripHtml(v.htmlBody) : null) });
    },
  );

  server.registerTool(
    "set_vacation_reply",
    {
      title: "Set auto-reply",
      description: "Turns the vacation auto-reply on or off and sets its message. With dates, it only answers mail that arrives between them.",
      inputSchema: z.object({
        enabled: z.boolean(),
        body: z.string().optional().describe("Plain-text reply message"),
        subject: z.string().optional().describe("Reply subject; the server picks one if omitted"),
        from: z.string().optional().describe("Start, ISO date or time, e.g. 2026-12-20"),
        to: z.string().optional().describe("Last day (inclusive) or an exact end time, ISO"),
      }),
      annotations: { destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (a, ctx) => {
      const { token, session } = await auth(ctx as Ctx);
      const patch: Record<string, unknown> = { isEnabled: a.enabled };
      if (a.body !== undefined) patch.textBody = a.body;
      if (a.subject !== undefined) patch.subject = a.subject || null;
      if (a.from !== undefined) patch.fromDate = a.from ? toDate(a.from) : null;
      // A date-only end means "through that day".
      if (a.to !== undefined) patch.toDate = !a.to ? null : /^\d{4}-\d{2}-\d{2}$/.test(a.to) ? new Date(Date.parse(toDate(a.to)) + 86_400_000).toISOString() : toDate(a.to);
      const r = await call(token, session, [["VacationResponse/set", { accountId: session.accountId, update: { singleton: patch } }, "v"]], VACATION);
      if (r.v.notUpdated?.singleton) throw new Error(`The server refused: ${JSON.stringify(r.v.notUpdated.singleton)}`);
      return reply({ enabled: a.enabled, ...patch });
    },
  );
}
