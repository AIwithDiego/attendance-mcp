import type { DatabaseSync } from "node:sqlite";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import * as q from "./queries.js";

const date = z.string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD")
  .refine((d) => !Number.isNaN(Date.parse(d)) && new Date(d).toISOString().startsWith(d), "Not a real calendar date");
const range = {
  from: date.optional().describe("Start date, inclusive (YYYY-MM-DD). Defaults to the start of the data."),
  to: date.optional().describe("End date, inclusive (YYYY-MM-DD). Defaults to the end of the data."),
};
const location = z.string().max(50).optional().describe("Site name, e.g. 'Dublin'. Omit for all sites.");
const grace = z.number().int().min(0).max(60).default(5)
  .describe("Minutes after the scheduled start before a clock-in counts as late.");

// All tools are read-only: they can report on attendance but never change a record.
const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };

function json(data: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
}

function rangeOf(sc: { from: string; to: string }) {
  return { from: sc.from, to: sc.to };
}

function error(message: string) {
  return { content: [{ type: "text" as const, text: message }], isError: true };
}

export function createServer(db: DatabaseSync): McpServer {
  const server = new McpServer({ name: "attendance-mcp", version: "0.1.0" });
  const defaults = q.dataRange(db);
  const sites = q.locationNames(db);

  // Shared input checks. An empty result must mean "nothing happened", never "you asked wrong",
  // because the model will report an empty list as fact.
  type Scope = { ok: true; from: string; to: string; location: string | null } | { ok: false; message: string };
  const scope = (p: { from?: string | undefined; to?: string | undefined; location?: string | undefined }): Scope => {
    const from = p.from ?? defaults.from;
    const to = p.to ?? defaults.to;
    if (to < defaults.from || from > defaults.to) {
      const asked = p.from && !p.to ? `from ${from} onwards`
        : p.to && !p.from ? `up to ${to}`
        : `between ${from} and ${to}`;
      return { ok: false, message: `No data ${asked}. The data covers ${defaults.from} to ${defaults.to}.` };
    }
    if (from > to) return { ok: false, message: `"from" (${from}) is after "to" (${to}).` };
    if (p.location === undefined) return { ok: true, from, to, location: null };
    const site = sites.find((name) => name.toLowerCase() === p.location!.trim().toLowerCase());
    if (!site) return { ok: false, message: `Unknown location "${p.location}". Valid locations: ${sites.join(", ")}.` };
    return { ok: true, from, to, location: site };
  };

  server.registerTool("list_locations", {
    title: "List locations",
    description: "List every site with its country, timezone and headcount. Also returns the date range the data covers.",
    annotations: READ_ONLY,
  }, async () => json({ data_range: defaults, locations: q.listLocations(db) }));

  server.registerTool("find_late_arrivals", {
    title: "Find late arrivals",
    description: "List individual late clock-ins, worst first. Use for 'who was late on X' questions.",
    inputSchema: {
      ...range,
      location,
      min_minutes_late: z.number().int().min(1).max(600).default(6).describe("Only include clock-ins at least this late."),
      limit: z.number().int().min(1).max(200).default(50),
    },
    annotations: READ_ONLY,
  }, async (a) => {
    const sc = scope(a);
    if (!sc.ok) return error(sc.message);
    return json(q.findLateArrivals(db, { ...rangeOf(sc), location: sc.location, minMinutesLate: a.min_minutes_late, limit: a.limit }));
  });

  server.registerTool("repeat_late_arrivals", {
    title: "Repeat late arrivals",
    description: "Rank employees who were late repeatedly, with late count, late rate and average minutes late. Use for 'who is regularly late' questions.",
    inputSchema: {
      ...range,
      location,
      grace_minutes: grace,
      min_times_late: z.number().int().min(1).max(100).default(3),
      limit: z.number().int().min(1).max(200).default(50),
    },
    annotations: READ_ONLY,
  }, async (a) => {
    const sc = scope(a);
    if (!sc.ok) return error(sc.message);
    return json(q.repeatLateArrivals(db, { ...rangeOf(sc), location: sc.location, graceMinutes: a.grace_minutes, minTimesLate: a.min_times_late, limit: a.limit }));
  });

  server.registerTool("employee_attendance", {
    title: "Employee attendance",
    description: "Attendance summary and incident list (late, no-show, missed clock-out) for one employee. Accepts an employee ID or part of a name; if several people match, returns up to 20 candidates instead.",
    inputSchema: {
      employee: z.string().min(1).max(80).describe("Employee ID or part of their name."),
      ...range,
      grace_minutes: grace,
    },
    annotations: READ_ONLY,
  }, async (a) => {
    const query = a.employee.trim();
    if (query === "") return error("Give an employee ID or part of their name.");
    const matches = q.findEmployees(db, query);
    if (matches.length === 0) return error(`No employee matches "${a.employee}".`);
    if (matches.length > 1) return json({ ambiguous: true, message: "Several employees match. Ask which one, then call again with their ID.", candidates: matches });
    const sc = scope({ from: a.from, to: a.to });
    if (!sc.ok) return error(sc.message);
    const employee = matches[0]!;
    const range = rangeOf(sc);
    return json({ employee, range, ...q.employeeAttendance(db, { ...range, employeeId: employee.id, graceMinutes: a.grace_minutes }) });
  });

  server.registerTool("location_trends", {
    title: "Location trends",
    description: "Late rate and no-shows per site, grouped by weekday or by week. Use to spot site-level patterns such as a bad day of the week. Weekly rows carry partial_week=true when the date range cuts into that week.",
    inputSchema: {
      ...range,
      location,
      group_by: z.enum(["weekday", "week"]).default("weekday"),
      grace_minutes: grace,
    },
    annotations: READ_ONLY,
  }, async (a) => {
    const sc = scope(a);
    if (!sc.ok) return error(sc.message);
    return json(q.locationTrends(db, { ...rangeOf(sc), location: sc.location, groupBy: a.group_by, graceMinutes: a.grace_minutes }));
  });

  server.registerTool("missing_clock_events", {
    title: "Missing clock events",
    description: "List no-shows (scheduled shift, no clock-in) and missed clock-outs (clocked in, never clocked out).",
    inputSchema: {
      ...range,
      location,
      type: z.enum(["no_show", "missed_clock_out", "all"]).default("all"),
      limit: z.number().int().min(1).max(200).default(100),
    },
    annotations: READ_ONLY,
  }, async (a) => {
    const sc = scope(a);
    if (!sc.ok) return error(sc.message);
    return json(q.missingClockEvents(db, { ...rangeOf(sc), location: sc.location, type: a.type, limit: a.limit }));
  });

  server.registerTool("repeat_missing_clock_events", {
    title: "Repeat no-shows and missed clock-outs",
    description: "Rank employees by no-shows and missed clock-outs, with counts and rates. Use for 'who keeps not turning up' or 'who forgets to clock out' questions.",
    inputSchema: {
      ...range,
      location,
      min_times: z.number().int().min(1).max(100).default(3)
        .describe("Include people with at least this many no-shows or at least this many missed clock-outs."),
      limit: z.number().int().min(1).max(200).default(50),
    },
    annotations: READ_ONLY,
  }, async (a) => {
    const sc = scope(a);
    if (!sc.ok) return error(sc.message);
    return json(q.repeatMissingClockEvents(db, { ...rangeOf(sc), location: sc.location, minTimes: a.min_times, limit: a.limit }));
  });

  server.registerResource("schema", "attendance://schema", {
    title: "Attendance data model",
    description: "Tables, definitions and caveats for the attendance data.",
    mimeType: "text/markdown",
  }, async (uri) => ({ contents: [{ uri: uri.href, mimeType: "text/markdown", text: SCHEMA_DOC }] }));

  server.registerPrompt("weekly_attendance_review", {
    title: "Weekly attendance review",
    description: "Review one week of attendance for a site (or all sites) and draft a short manager summary.",
    argsSchema: {
      week_start: date.describe("Monday of the week to review (YYYY-MM-DD)."),
      location: z.enum(sites as [string, ...string[]]).optional(),
    },
  }, ({ week_start, location }) => ({
    messages: [{
      role: "user",
      content: {
        type: "text",
        text: [
          `Review attendance for the week starting ${week_start}${location ? ` at ${location}` : " across all sites"}.`,
          "Use the attendance tools: repeat_late_arrivals, repeat_missing_clock_events and location_trends for that week, and compare with the previous four weeks.",
          "Then write a short summary for the site manager: who needs a conversation, any site-level pattern, and anything that looks like a data problem (for example missed clock-outs) rather than a behaviour problem.",
          "Stick to the facts in the data. Do not guess at reasons for lateness.",
        ].join("\n"),
      },
    }],
  }));

  return server;
}

const SCHEMA_DOC = `# Attendance data model

All data is synthetic.

- **locations**: sites (Dublin, Cork, Manchester, Belfast) with country and timezone.
- **employees**: name, role, home location.
- **shifts**: scheduled start and end, in the site's local time.
- **clock_events**: one per attended shift: clock_in, and clock_out (NULL if the employee never clocked out).

## Definitions
- **Late**: clock-in more than \`grace_minutes\` (default 5) after the scheduled start.
- **late_rate_pct**: late shifts as a share of *attended* shifts, in every tool. No-shows are counted separately, never as late.
- **No-show**: a scheduled shift with no clock-in at all.
- **Missed clock-out**: clocked in, never clocked out. Usually a process problem, not a behaviour one.

## Caveats
- Times are local to each site; cross-site comparisons of clock times ignore timezones.
- Every tool is read-only.
`;
