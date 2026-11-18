import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/server";
import { call, download, upload, SIEVE, type Session } from "./jmap";
import { auth, reply, type Ctx } from "./tools";

// Mail filters are Sieve scripts (RFC 5228) managed over JMAP (RFC 9661). The server runs
// only the active script, so rules are added by editing that script.

type Script = { id: string; name: string; blobId: string; isActive: boolean };

const run = (token: string, s: Session, calls: [string, Record<string, unknown>, string][]) => call(token, s, calls, SIEVE);

async function getScripts(token: string, s: Session): Promise<Script[]> {
  const r = await run(token, s, [["SieveScript/get", { accountId: s.accountId }, "g"]]);
  return r.g.list;
}

const findScript = (list: Script[], name: string) => list.find((x) => x.name === name || x.id === name);

export function registerFilterTools(server: McpServer) {
  server.registerTool(
    "list_filters",
    {
      title: "List mail filters",
      description: "Returns your Sieve filter scripts with their full text. Only the active script runs. To add or change a rule, edit the active script's text and save it with save_filters.",
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true },
    },
    async (_args, ctx) => {
      const { token, session } = await auth(ctx as Ctx);
      const scripts = await getScripts(token, session);
      const out = await Promise.all(
        scripts.map(async (x) => ({
          name: x.name,
          active: x.isActive,
          script: new TextDecoder().decode(await download(token, session, x.blobId, `${x.name}.sieve`, "application/sieve")),
        })),
      );
      return reply(out.length ? out : "No filter scripts yet. save_filters creates one.");
    },
  );

  server.registerTool(
    "save_filters",
    {
      title: "Save mail filters",
      description:
        'Saves a Sieve script (creating it or replacing its text) and makes it the active one. The script is checked first and nothing changes if it has errors. Keep every existing rule you aren\'t changing. Example rule: require ["fileinto"]; if address :is "from" "news@example.com" { fileinto "Newsletters"; }',
      inputSchema: z.object({
        name: z.string().default("filters").describe("Script name; use the active script's name to edit it"),
        script: z.string().describe("The complete Sieve script"),
        activate: z.boolean().default(true),
      }),
      annotations: { destructiveHint: false },
    },
    async (a, ctx) => {
      const { token, session } = await auth(ctx as Ctx);
      const acct = session.accountId;
      const blobId = await upload(token, session, new TextEncoder().encode(a.script), "application/sieve");
      const v = await run(token, session, [["SieveScript/validate", { accountId: acct, blobId }, "v"]]);
      if (v.v.error) throw new Error(`The script has errors, nothing was saved: ${v.v.error.description ?? JSON.stringify(v.v.error)}`);

      const existing = findScript(await getScripts(token, session), a.name);
      const set: Record<string, unknown> = { accountId: acct };
      if (existing) set.update = { [existing.id]: { blobId } };
      else set.create = { s: { name: a.name, blobId } };
      if (a.activate) set.onSuccessActivateScript = existing ? existing.id : "#s";
      const r = await run(token, session, [["SieveScript/set", set, "s"]]);
      const fail = r.s.notCreated?.s ?? r.s.notUpdated?.[existing?.id ?? ""];
      if (fail) throw new Error(`The server refused the script: ${fail.description ?? JSON.stringify(fail)}`);
      return reply({ saved: a.name, created: !existing, active: a.activate || existing?.isActive });
    },
  );

  server.registerTool(
    "delete_filters",
    {
      title: "Delete mail filters",
      description: "Deletes a Sieve script. An active script is turned off first, so no filters run until another is activated.",
      inputSchema: z.object({ name: z.string() }),
      annotations: { destructiveHint: true },
    },
    async ({ name }, ctx) => {
      const { token, session } = await auth(ctx as Ctx);
      const scripts = await getScripts(token, session);
      const x = findScript(scripts, name);
      if (!x) throw new Error(`No script "${name}". Scripts: ${scripts.map((s) => s.name).join(", ") || "none"}`);
      const calls: [string, Record<string, unknown>, string][] = [];
      if (x.isActive) calls.push(["SieveScript/set", { accountId: session.accountId, onSuccessDeactivateScript: true }, "off"]);
      calls.push(["SieveScript/set", { accountId: session.accountId, destroy: [x.id] }, "d"]);
      const r = await run(token, session, calls);
      if (r.d.notDestroyed?.[x.id]) throw new Error(`The server refused: ${JSON.stringify(r.d.notDestroyed[x.id])}`);
      return reply({ deleted: x.name, wasActive: x.isActive });
    },
  );
}
