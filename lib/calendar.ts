import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/server";
import { call, CALENDARS, type Session } from "./jmap";
import { auth, getIdentities, reply, type Ctx } from "./tools";

// Events are JSCalendar objects (RFC 8984). Times are local to the event's timeZone;
// utcStart/utcEnd are computed by the server.

type Calendar = { id: string; name: string; description?: string | null; isDefault?: boolean; timeZone?: string | null };

function accountId(s: Session): string {
  if (!s.calendarAccountId) throw new Error("No calendar access. Disconnect and reconnect the connector to grant it.");
  return s.calendarAccountId;
}

const run = (token: string, s: Session, calls: [string, Record<string, unknown>, string][]) => call(token, s, calls, CALENDARS);

async function getCalendars(token: string, s: Session): Promise<Calendar[]> {
  const r = await run(token, s, [["Calendar/get", { accountId: accountId(s) }, "c"]]);
  return r.c.list;
}

function findCalendar(list: Calendar[], ref?: string): Calendar {
  if (!ref) {
    const found = list.find((c) => c.isDefault) ?? list[0];
    if (!found) throw new Error("This account has no calendars.");
    return found;
  }
  const lc = ref.trim().toLowerCase();
  const found = list.find((c) => c.id === ref) ?? list.find((c) => c.name.toLowerCase() === lc);
  if (!found) throw new Error(`No calendar "${ref}". Available: ${list.map((c) => c.name).join(", ")}`);
  return found;
}

const mailto = (a?: string | null) => (a ?? "").replace(/^mailto:/i, "").toLowerCase();
const participantEmail = (p: any) => mailto(p.calendarAddress ?? p.sendTo?.imip ?? p.email);

/** Every address that is "me" on an invite: calendar identities plus mail sending addresses. */
async function myAddresses(token: string, s: Session): Promise<Set<string>> {
  const r = await run(token, s, [["ParticipantIdentity/get", { accountId: accountId(s) }, "p"]]);
  const mine = new Set<string>(r.p.list.map((p: any) => mailto(p.calendarAddress)));
  for (const i of await getIdentities(token, s)) mine.add(i.email.toLowerCase());
  mine.add(s.username.toLowerCase());
  return mine;
}

const SUMMARY = ["id", "baseEventId", "calendarIds", "title", "start", "timeZone", "duration", "showWithoutTime", "utcStart", "utcEnd", "locations", "status", "recurrenceRules", "participants"];

function summarize(e: any, names: Record<string, string>, mine?: Set<string>) {
  const parts = Object.values(e.participants ?? {}) as any[];
  const me = mine && parts.find((p) => mine.has(participantEmail(p)));
  return {
    id: e.id,
    seriesId: e.baseEventId && e.baseEventId !== e.id ? e.baseEventId : undefined,
    title: e.title,
    start: e.start,
    timeZone: e.timeZone ?? undefined,
    duration: e.duration,
    utcStart: e.utcStart,
    utcEnd: e.utcEnd,
    allDay: !!e.showWithoutTime || undefined,
    location: (Object.values(e.locations ?? {}) as any[]).map((l) => l.name).filter(Boolean).join("; ") || undefined,
    status: e.status && e.status !== "confirmed" ? e.status : undefined,
    repeats: e.recurrenceRules?.length ? true : undefined,
    attendees: parts.length || undefined,
    myResponse: me?.participationStatus,
    calendars: Object.keys(e.calendarIds ?? {}).map((id) => names[id] ?? id),
  };
}

/** Accepts 2026-11-20, 2026-11-20T15:00 or 2026-11-20T15:00:00 and returns a JSCalendar LocalDateTime. */
function localTime(v: string): string {
  const m = v.trim().match(/^(\d{4}-\d{2}-\d{2})(?:[T ](\d{2}:\d{2})(:\d{2})?)?$/);
  if (!m) throw new Error(`"${v}" isn't a local date or time. Use 2026-11-20 or 2026-11-20T15:00 (no Z or offset) and pass time_zone.`);
  return `${m[1]}T${m[2] ?? "00:00"}${m[3] ?? ":00"}`;
}

const isDateOnly = (v: string) => /^\d{4}-\d{2}-\d{2}$/.test(v.trim());

/** ISO 8601 duration between two local times in the same zone. */
function durationBetween(start: string, end: string): string {
  const mins = Math.round((Date.parse(`${end}Z`) - Date.parse(`${start}Z`)) / 60_000);
  if (mins <= 0) throw new Error("end must be after start.");
  const d = Math.floor(mins / 1440), h = Math.floor((mins % 1440) / 60), m = mins % 60;
  return `P${d ? `${d}D` : ""}${h || m ? "T" : ""}${h ? `${h}H` : ""}${m ? `${m}M` : ""}`;
}

function attendee(email: string) {
  return { "@type": "Participant", calendarAddress: `mailto:${email}`, roles: { attendee: true }, participationStatus: "needs-action", expectReply: true };
}

const when = {
  start: z.string().describe("Local start, e.g. 2026-11-20T15:00, or a date like 2026-11-20 for an all-day event"),
  end: z.string().optional().describe("Local end in the same form. For all-day events, the last day. Defaults to 1 hour, or 1 day when all-day"),
  time_zone: z.string().optional().describe("IANA time zone such as America/New_York. Defaults to the calendar's zone"),
};

/** Builds start, duration, timeZone and showWithoutTime from tool arguments. */
function timing(a: { start: string; end?: string; time_zone?: string }, fallbackZone?: string | null) {
  const allDay = isDateOnly(a.start);
  const start = localTime(a.start);
  let duration = allDay ? "P1D" : "PT1H";
  if (a.end) {
    const end = localTime(a.end);
    // An all-day end is the last day, inclusive.
    duration = durationBetween(start, allDay ? new Date(Date.parse(`${end}Z`) + 86_400_000).toISOString().slice(0, 19) : end);
  }
  const timeZone = allDay ? null : a.time_zone ?? fallbackZone ?? "Etc/UTC";
  return { start, duration, timeZone, showWithoutTime: allDay };
}

function setErrors(r: any, key: string, verb: string) {
  const fail = r.notCreated?.[key] ?? r.notUpdated?.[key] ?? r.notDestroyed?.[key];
  if (fail) throw new Error(`The server refused to ${verb} the event: ${JSON.stringify(fail)}`);
}

const notify = z.boolean().default(true).describe("Email invitations, updates or replies to the other participants");

export function registerCalendarTools(server: McpServer) {
  server.registerTool(
    "list_calendars",
    {
      title: "List calendars",
      description: "Lists calendars with their ids, names, time zones and which one is the default.",
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true },
    },
    async (_args, ctx) => {
      const { token, session } = await auth(ctx as Ctx);
      const list = await getCalendars(token, session);
      return reply(list.map((c) => ({ id: c.id, name: c.name, description: c.description || undefined, timeZone: c.timeZone ?? undefined, isDefault: !!c.isDefault })));
    },
  );

  server.registerTool(
    "search_events",
    {
      title: "Search calendar",
      description: "Lists events overlapping a time range, earliest first, with each occurrence of a repeating event listed separately. Use get_event for details.",
      inputSchema: z.object({
        after: z.string().optional().describe("Local date or time the range starts, e.g. 2026-11-18. Defaults to today"),
        before: z.string().optional().describe("Local date or time the range ends. Defaults to 14 days after the start"),
        time_zone: z.string().optional().describe("IANA time zone for after and before, e.g. America/New_York"),
        query: z.string().optional().describe("Text to match in title, description, location or participants"),
        calendar: z.string().optional().describe("Calendar name or id; all calendars if omitted"),
        limit: z.number().int().min(1).max(200).default(50),
      }),
      annotations: { readOnlyHint: true },
    },
    async (a, ctx) => {
      const { token, session } = await auth(ctx as Ctx);
      const cals = await getCalendars(token, session);
      const names = Object.fromEntries(cals.map((c) => [c.id, c.name]));
      const after = localTime(a.after ?? new Date().toISOString().slice(0, 10));
      const before = a.before ? localTime(a.before) : new Date(Date.parse(`${after}Z`) + 14 * 86_400_000).toISOString().slice(0, 19);
      const filter: Record<string, unknown> = { after, before };
      if (a.query) filter.text = a.query;
      if (a.calendar) filter.inCalendar = findCalendar(cals, a.calendar).id;
      const acct = accountId(session);
      const [r, mine] = await Promise.all([
        run(token, session, [
          ["CalendarEvent/query", { accountId: acct, filter, sort: [{ property: "start", isAscending: true }], expandRecurrences: true, ...(a.time_zone ? { timeZone: a.time_zone } : {}), limit: a.limit }, "q"],
          ["CalendarEvent/get", { accountId: acct, "#ids": { resultOf: "q", name: "CalendarEvent/query", path: "/ids" }, properties: SUMMARY }, "g"],
        ]),
        myAddresses(token, session),
      ]);
      return reply({ after, before, results: r.g.list.map((e: any) => summarize(e, names, mine)) });
    },
  );

  server.registerTool(
    "get_event",
    {
      title: "Read event",
      description: "Returns one event with its description, participants and their responses, video links, repeat rule and reminders.",
      inputSchema: z.object({ id: z.string() }),
      annotations: { readOnlyHint: true },
    },
    async ({ id }, ctx) => {
      const { token, session } = await auth(ctx as Ctx);
      const [cals, mine, r] = await Promise.all([
        getCalendars(token, session),
        myAddresses(token, session),
        run(token, session, [["CalendarEvent/get", { accountId: accountId(session), ids: [id] }, "g"]]),
      ]);
      const e = r.g.list[0];
      if (!e) throw new Error(`No event with id ${id}`);
      const names = Object.fromEntries(cals.map((c) => [c.id, c.name]));
      return reply({
        ...summarize(e, names, mine),
        uid: e.uid,
        description: e.description || undefined,
        links: e.virtualLocations ? (Object.values(e.virtualLocations) as any[]).map((v) => v.uri) : undefined,
        participants: (Object.values(e.participants ?? {}) as any[]).map((p) => ({
          name: p.name || undefined,
          email: participantEmail(p) || undefined,
          organizer: !!p.roles?.owner || undefined,
          response: p.participationStatus,
          me: mine.has(participantEmail(p)) || undefined,
        })),
        recurrenceRules: e.recurrenceRules,
        excludedOrChangedOccurrences: e.recurrenceOverrides ? Object.keys(e.recurrenceOverrides).length : undefined,
        alerts: e.alerts ? Object.values(e.alerts).map((x: any) => x.trigger) : undefined,
      });
    },
  );

  server.registerTool(
    "create_event",
    {
      title: "Create event",
      description: "Adds an event. With attendees, you are the organizer and invitations are emailed unless notify is false.",
      inputSchema: z.object({
        title: z.string(),
        ...when,
        calendar: z.string().optional().describe("Calendar name or id; the default calendar if omitted"),
        description: z.string().optional(),
        location: z.string().optional(),
        attendees: z.array(z.string()).optional().describe("Email addresses to invite"),
        notify,
      }),
      annotations: { destructiveHint: false, openWorldHint: true },
    },
    async (a, ctx) => {
      const { token, session } = await auth(ctx as Ctx);
      const cal = findCalendar(await getCalendars(token, session), a.calendar);
      const event: Record<string, unknown> = {
        "@type": "Event",
        calendarIds: { [cal.id]: true },
        title: a.title,
        ...timing(a, cal.timeZone),
        ...(a.description ? { description: a.description } : {}),
        ...(a.location ? { locations: { l1: { "@type": "Location", name: a.location } } } : {}),
      };
      if (a.attendees?.length) {
        const me = session.username;
        event.organizerCalendarAddress = `mailto:${me}`;
        event.participants = {
          me: { "@type": "Participant", calendarAddress: `mailto:${me}`, roles: { owner: true, attendee: true }, participationStatus: "accepted" },
          ...Object.fromEntries(a.attendees.map((x, i) => [`a${i + 1}`, attendee(x.trim())])),
        };
      }
      const r = await run(token, session, [["CalendarEvent/set", { accountId: accountId(session), create: { e: event }, sendSchedulingMessages: a.notify }, "s"]]);
      setErrors(r.s, "e", "create");
      return reply({ created: true, id: r.s.created.e.id, calendar: cal.name, start: event.start, timeZone: event.timeZone ?? undefined, duration: event.duration });
    },
  );

  server.registerTool(
    "update_event",
    {
      title: "Update event",
      description: "Changes an event. Only the fields you pass change. Changing start without end keeps the current length. An occurrence id from search_events changes just that occurrence; its seriesId changes the whole series.",
      inputSchema: z.object({
        id: z.string(),
        title: z.string().optional(),
        start: when.start.optional(),
        end: when.end,
        time_zone: when.time_zone,
        calendar: z.string().optional().describe("Move to this calendar (name or id)"),
        description: z.string().optional(),
        location: z.string().optional().describe("New location; empty string removes it"),
        add_attendees: z.array(z.string()).optional(),
        remove_attendees: z.array(z.string()).optional(),
        notify,
      }),
      annotations: { destructiveHint: false, openWorldHint: true },
    },
    async (a, ctx) => {
      const { token, session } = await auth(ctx as Ctx);
      const acct = accountId(session);
      const r0 = await run(token, session, [["CalendarEvent/get", { accountId: acct, ids: [a.id], properties: ["start", "duration", "timeZone", "showWithoutTime", "participants"] }, "g"]]);
      const cur = r0.g.list[0];
      if (!cur) throw new Error(`No event with id ${a.id}`);

      const patch: Record<string, unknown> = {};
      if (a.title !== undefined) patch.title = a.title;
      if (a.description !== undefined) patch.description = a.description;
      if (a.location !== undefined) patch.locations = a.location ? { l1: { "@type": "Location", name: a.location } } : null;
      if (a.calendar) patch.calendarIds = { [findCalendar(await getCalendars(token, session), a.calendar).id]: true };
      if (a.start || a.end || a.time_zone) {
        if (a.start) {
          const t = timing({ start: a.start, end: a.end, time_zone: a.time_zone ?? cur.timeZone ?? undefined });
          Object.assign(patch, t, a.end ? {} : { duration: isDateOnly(a.start) === !!cur.showWithoutTime ? cur.duration : t.duration });
        } else {
          if (a.end) {
            const end = localTime(a.end);
            patch.duration = durationBetween(cur.start, cur.showWithoutTime ? new Date(Date.parse(`${end}Z`) + 86_400_000).toISOString().slice(0, 19) : end);
          }
          if (a.time_zone) patch.timeZone = a.time_zone;
        }
      }
      if (a.add_attendees?.length || a.remove_attendees?.length) {
        const parts: Record<string, any> = { ...(cur.participants ?? {}) };
        const drop = new Set((a.remove_attendees ?? []).map((x) => x.trim().toLowerCase()));
        for (const [k, p] of Object.entries(parts)) if (drop.has(participantEmail(p))) delete parts[k];
        const have = new Set(Object.values(parts).map(participantEmail));
        if (!Object.keys(parts).length) {
          patch.organizerCalendarAddress = `mailto:${session.username}`;
          parts.me = { "@type": "Participant", calendarAddress: `mailto:${session.username}`, roles: { owner: true, attendee: true }, participationStatus: "accepted" };
        }
        for (const x of a.add_attendees ?? []) if (!have.has(x.trim().toLowerCase())) parts[`a${crypto.randomUUID().slice(0, 8)}`] = attendee(x.trim());
        patch.participants = parts;
      }
      if (!Object.keys(patch).length) throw new Error("Nothing to change.");
      const r = await run(token, session, [["CalendarEvent/set", { accountId: acct, update: { [a.id]: patch }, sendSchedulingMessages: a.notify }, "s"]]);
      setErrors(r.s, a.id, "update");
      return reply({ updated: true, id: a.id, changed: Object.keys(patch) });
    },
  );

  server.registerTool(
    "respond_to_event",
    {
      title: "Reply to invitation",
      description: "Accepts, declines or tentatively accepts an invitation, and by default emails the reply to the organizer. Use the seriesId to answer for every occurrence of a repeating invite.",
      inputSchema: z.object({ id: z.string(), response: z.enum(["accepted", "declined", "tentative"]), notify }),
      annotations: { destructiveHint: false, openWorldHint: true },
    },
    async (a, ctx) => {
      const { token, session } = await auth(ctx as Ctx);
      const acct = accountId(session);
      const [mine, r0] = await Promise.all([
        myAddresses(token, session),
        run(token, session, [["CalendarEvent/get", { accountId: acct, ids: [a.id], properties: ["participants"] }, "g"]]),
      ]);
      const e = r0.g.list[0];
      if (!e) throw new Error(`No event with id ${a.id}`);
      const key = Object.entries(e.participants ?? {}).find(([, p]) => mine.has(participantEmail(p)))?.[0];
      if (!key) throw new Error("You aren't a participant in this event, so there's nothing to reply to.");
      const r = await run(token, session, [["CalendarEvent/set", { accountId: acct, update: { [a.id]: { [`participants/${key}/participationStatus`]: a.response } }, sendSchedulingMessages: a.notify }, "s"]]);
      setErrors(r.s, a.id, "update");
      return reply({ responded: a.response, as: participantEmail((e.participants as any)[key]) });
    },
  );

  server.registerTool(
    "delete_event",
    {
      title: "Delete event",
      description: "Deletes events. An occurrence id from search_events deletes just that occurrence; its seriesId deletes the whole series. If you organized it, attendees are emailed a cancellation unless notify is false.",
      inputSchema: z.object({ ids: z.array(z.string()).min(1), notify }),
      annotations: { destructiveHint: true },
    },
    async ({ ids, notify }, ctx) => {
      const { token, session } = await auth(ctx as Ctx);
      const r = await run(token, session, [["CalendarEvent/set", { accountId: accountId(session), destroy: ids, sendSchedulingMessages: notify }, "d"]]);
      return reply({ deleted: (r.d.destroyed ?? []).length, failed: r.d.notDestroyed });
    },
  );
}
