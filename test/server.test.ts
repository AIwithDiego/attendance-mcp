import { beforeAll, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createDatabase, PLANTED } from "../src/seed.js";
import { createServer } from "../src/server.js";

// These tests talk to the server through a real MCP client, the same way
// Claude does, over an in-memory transport instead of stdio.

let client: Client;

async function call(name: string, args: Record<string, unknown> = {}) {
  const result = await client.callTool({ name, arguments: args });
  const [first] = result.content as { type: string; text: string }[];
  return { isError: result.isError === true, text: first!.text, data: safeJson(first!.text) };
}

function safeJson(text: string): any {
  try { return JSON.parse(text); } catch { return undefined; }
}

beforeAll(async () => {
  const server = createServer(createDatabase());
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: "test-client", version: "0.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
});

describe("discovery", () => {
  it("lists all seven tools, each marked read-only", async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      "employee_attendance", "find_late_arrivals", "list_locations",
      "location_trends", "missing_clock_events", "repeat_late_arrivals",
      "repeat_missing_clock_events",
    ]);
    for (const tool of tools) expect(tool.annotations?.readOnlyHint).toBe(true);
  });

  it("exposes the schema resource and the review prompt", async () => {
    const resource = await client.readResource({ uri: "attendance://schema" });
    expect((resource.contents[0] as { text: string }).text).toContain("No-show");

    const prompt = await client.getPrompt({ name: "weekly_attendance_review", arguments: { week_start: "2026-09-14", location: "Cork" } });
    expect(JSON.stringify(prompt.messages)).toContain("week starting 2026-09-14 at Cork");
  });
});

describe("tools find the planted patterns", () => {
  it("list_locations returns four sites of ten people", async () => {
    const { data } = await call("list_locations");
    expect(data.locations).toHaveLength(4);
    expect(data.locations.every((l: { headcount: number }) => l.headcount === 10)).toBe(true);
    expect(data.data_range).toEqual({ from: "2026-07-27", to: "2026-09-20" });
  });

  it("repeat_late_arrivals puts the chronic late-comer first", async () => {
    const { data } = await call("repeat_late_arrivals", { location: "Manchester" });
    expect(data[0].employee).toBe(PLANTED.chronicLate);
    expect(data[0].late_rate_pct).toBeGreaterThan(40);
  });

  it("location_trends shows the Monday problem in Belfast", async () => {
    const { data } = await call("location_trends", { location: "Belfast", group_by: "weekday" });
    const monday = data.find((r: { bucket: string }) => r.bucket === "1 Mon");
    const others = data.filter((r: { bucket: string }) => r.bucket !== "1 Mon");
    for (const day of others) expect(monday.late_rate_pct).toBeGreaterThan(day.late_rate_pct);
  });

  it("missing_clock_events surfaces no-shows and missed clock-outs", async () => {
    const noShows = (await call("missing_clock_events", { type: "no_show", location: "Dublin" })).data;
    const top = mostCommon(noShows.map((r: { employee: string }) => r.employee));
    expect(top).toBe(PLANTED.noShows);

    const missed = (await call("missing_clock_events", { type: "missed_clock_out", location: "Cork" })).data;
    expect(mostCommon(missed.map((r: { employee: string }) => r.employee))).toBe(PLANTED.missedClockOuts);
  });

  it("find_late_arrivals respects the threshold and the date range", async () => {
    const { data } = await call("find_late_arrivals", { from: "2026-09-14", to: "2026-09-20", min_minutes_late: 20 });
    expect(data.length).toBeGreaterThan(0);
    for (const row of data) {
      expect(row.minutes_late).toBeGreaterThanOrEqual(20);
      expect(row.scheduled_start >= "2026-09-14" && row.scheduled_start <= "2026-09-20 99").toBe(true);
    }
  });
});

describe("employee_attendance", () => {
  it("summarises one employee by name", async () => {
    const { data } = await call("employee_attendance", { employee: PLANTED.noShows });
    expect(data.employee.name).toBe(PLANTED.noShows);
    expect(data.summary.no_shows).toBeGreaterThan(3);
  });

  it("asks for clarification when a name is ambiguous", async () => {
    const { data } = await call("employee_attendance", { employee: "a" });
    expect(data.ambiguous).toBe(true);
    expect(data.candidates.length).toBeGreaterThan(1);
  });

  it("returns a tool error for an unknown employee", async () => {
    const result = await call("employee_attendance", { employee: "Nobody Here" });
    expect(result.isError).toBe(true);
  });
});

describe("input validation", () => {
  it("rejects a malformed date before it reaches the database", async () => {
    const result = await call("find_late_arrivals", { from: "14/09/2026" });
    expect(result.isError).toBe(true);
  });

  it("treats SQL in a text field as plain text", async () => {
    const result = await call("repeat_late_arrivals", { location: "Dublin' OR '1'='1" });
    expect(result.isError).toBe(true);
    expect(result.text).toContain("Unknown location");
  });
});

// Regressions from the live test session (docs/test-session-2026-09-25.md).
describe("regressions", () => {
  it("bug 1: weekly buckets start on the Monday of the shift's own week", async () => {
    const { data } = await call("location_trends", { location: "Belfast", group_by: "week" });
    expect(data[0].bucket).toBe("2026-07-27");
    expect(data).toHaveLength(8);
    for (const week of data) {
      expect(week.scheduled_shifts).toBe(50);
      expect(week.partial_week).toBe(false);
    }
  });

  it("bug 2: a shift that is late and missing its clock-out carries both types", async () => {
    const { data } = await call("employee_attendance", { employee: PLANTED.chronicLate });
    const both = data.incidents.filter((i: { types: string[] }) => i.types.includes("late") && i.types.includes("missed_clock_out"));
    expect(both.length).toBeGreaterThan(0);
    const missed = data.incidents.filter((i: { types: string[] }) => i.types.includes("missed_clock_out")).length;
    expect(missed).toBe(data.summary.missed_clock_outs);
  });

  it("bug 3: an unknown location is an error that lists the valid ones", async () => {
    const result = await call("find_late_arrivals", { location: "Narnia" });
    expect(result.isError).toBe(true);
    expect(result.text).toContain("Belfast, Cork, Dublin, Manchester");
  });

  it("bug 3: a reversed date range is an error", async () => {
    const result = await call("repeat_late_arrivals", { from: "2026-09-20", to: "2026-07-27" });
    expect(result.isError).toBe(true);
  });

  it("bug 3: a range outside the data says where the data is", async () => {
    const result = await call("missing_clock_events", { from: "2027-01-01" });
    expect(result.isError).toBe(true);
    expect(result.text).toContain("2026-07-27 to 2026-09-20");
  });

  it("gap: repeat_missing_clock_events ranks the planted no-shows and missed clock-outs", async () => {
    const dublin = (await call("repeat_missing_clock_events", { location: "Dublin" })).data;
    expect(dublin[0].employee).toBe(PLANTED.noShows);
    const cork = (await call("repeat_missing_clock_events", { location: "Cork" })).data;
    expect(cork[0].employee).toBe(PLANTED.missedClockOuts);
  });
});

// Regressions from the second live session (docs/test-session-2026-09-25-run2.md).
describe("regressions, run 2", () => {
  it("% and _ in a name search match literally, not everyone", async () => {
    for (const employee of ["%", "_", "a%"]) {
      const result = await call("employee_attendance", { employee });
      expect(result.isError).toBe(true);
    }
  });

  it("a blank name search is an error, not a match for everyone", async () => {
    const result = await call("employee_attendance", { employee: "   " });
    expect(result.isError).toBe(true);
  });

  it("a one-sided out-of-range query names only the date that was given", async () => {
    const after = await call("find_late_arrivals", { from: "2027-01-01" });
    expect(after.text).toContain("No data from 2027-01-01 onwards");
    const before = await call("find_late_arrivals", { to: "2026-01-01" });
    expect(before.text).toContain("No data up to 2026-01-01");
  });

  it("impossible calendar dates are rejected", async () => {
    const result = await call("find_late_arrivals", { from: "2026-02-30" });
    expect(result.isError).toBe(true);
  });

  it("weeks cut by a midweek range are marked partial", async () => {
    const { data } = await call("location_trends", { location: "Cork", group_by: "week", from: "2026-08-05", to: "2026-08-20" });
    expect(data.map((w: { partial_week: boolean }) => w.partial_week)).toEqual([true, false, true]);
  });

  it("late_rate_pct means late / attended shifts in both the ranking and the site trends", async () => {
    const [person] = (await call("repeat_late_arrivals", { location: "Manchester" })).data;
    expect(person.late_rate_pct).toBeCloseTo((100 * person.times_late) / person.attended_shifts, 1);

    const trends = (await call("location_trends", { location: "Dublin" })).data;
    for (const row of trends) {
      expect(row.attended_shifts).toBe(row.scheduled_shifts - row.no_shows);
      expect(row.late_rate_pct).toBeCloseTo((100 * row.times_late) / row.attended_shifts, 1);
    }
  });
});

function mostCommon(xs: string[]): string | undefined {
  const counts = new Map<string, number>();
  for (const x of xs) counts.set(x, (counts.get(x) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
}
