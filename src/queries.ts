import type { DatabaseSync } from "node:sqlite";

// Every query takes named parameters; no user input is ever concatenated into SQL.

export type Range = {
  from: string; // YYYY-MM-DD, inclusive
  to: string;   // YYYY-MM-DD, inclusive
};

const MINUTES_LATE = "ROUND((julianday(c.clock_in) - julianday(s.scheduled_start)) * 1440)";
const IN_RANGE = "date(s.scheduled_start) BETWEEN :from AND :to";
const AT_LOCATION = "(:location IS NULL OR l.name = :location COLLATE NOCASE)";

export function dataRange(db: DatabaseSync): Range {
  return db
    .prepare("SELECT date(MIN(scheduled_start)) AS \"from\", date(MAX(scheduled_start)) AS \"to\" FROM shifts")
    .get() as unknown as Range;
}

export function listLocations(db: DatabaseSync) {
  return db
    .prepare(`
      SELECT l.name, l.country, l.timezone, COUNT(e.id) AS headcount
      FROM locations l LEFT JOIN employees e ON e.location_id = l.id
      GROUP BY l.id ORDER BY l.name`)
    .all();
}

export function findLateArrivals(
  db: DatabaseSync,
  p: Range & { location: string | null; minMinutesLate: number; limit: number },
) {
  return db
    .prepare(`
      SELECT e.id AS employee_id, e.name AS employee, l.name AS location,
             s.scheduled_start, c.clock_in, ${MINUTES_LATE} AS minutes_late
      FROM shifts s
      JOIN clock_events c ON c.shift_id = s.id
      JOIN employees e ON e.id = s.employee_id
      JOIN locations l ON l.id = s.location_id
      WHERE ${IN_RANGE} AND ${AT_LOCATION} AND ${MINUTES_LATE} >= :minMinutesLate
      ORDER BY minutes_late DESC, s.scheduled_start
      LIMIT :limit`)
    .all(p);
}

export function repeatLateArrivals(
  db: DatabaseSync,
  p: Range & { location: string | null; graceMinutes: number; minTimesLate: number; limit: number },
) {
  return db
    .prepare(`
      SELECT e.id AS employee_id, e.name AS employee, l.name AS location,
             COUNT(s.id) AS attended_shifts,
             SUM(${MINUTES_LATE} > :graceMinutes) AS times_late,
             ROUND(100.0 * SUM(${MINUTES_LATE} > :graceMinutes) / COUNT(s.id), 1) AS late_rate_pct,
             ROUND(AVG(CASE WHEN ${MINUTES_LATE} > :graceMinutes THEN ${MINUTES_LATE} END), 1) AS avg_minutes_late
      FROM shifts s
      JOIN clock_events c ON c.shift_id = s.id
      JOIN employees e ON e.id = s.employee_id
      JOIN locations l ON l.id = s.location_id
      WHERE ${IN_RANGE} AND ${AT_LOCATION}
      GROUP BY e.id
      HAVING times_late >= :minTimesLate
      ORDER BY times_late DESC, late_rate_pct DESC
      LIMIT :limit`)
    .all(p);
}

export function locationNames(db: DatabaseSync): string[] {
  return (db.prepare("SELECT name FROM locations ORDER BY name").all() as { name: string }[]).map((r) => r.name);
}

export function repeatMissingClockEvents(
  db: DatabaseSync,
  p: Range & { location: string | null; minTimes: number; limit: number },
) {
  return db
    .prepare(`
      SELECT e.id AS employee_id, e.name AS employee, l.name AS location,
             COUNT(s.id) AS shifts,
             SUM(c.shift_id IS NULL) AS no_shows,
             SUM(c.shift_id IS NOT NULL AND c.clock_out IS NULL) AS missed_clock_outs,
             ROUND(100.0 * SUM(c.shift_id IS NULL) / COUNT(s.id), 1) AS no_show_rate_pct,
             ROUND(100.0 * SUM(c.shift_id IS NOT NULL AND c.clock_out IS NULL) / COUNT(s.id), 1) AS missed_clock_out_rate_pct
      FROM shifts s
      LEFT JOIN clock_events c ON c.shift_id = s.id
      JOIN employees e ON e.id = s.employee_id
      JOIN locations l ON l.id = s.location_id
      WHERE ${IN_RANGE} AND ${AT_LOCATION}
      GROUP BY e.id
      HAVING no_shows >= :minTimes OR missed_clock_outs >= :minTimes
      ORDER BY no_shows + missed_clock_outs DESC
      LIMIT :limit`)
    .all(p);
}

export function findEmployees(db: DatabaseSync, query: string) {
  const asId = /^\d+$/.test(query) ? Number(query) : null;
  // % and _ are LIKE wildcards; escape them so a name search matches the characters literally.
  const literal = query.replace(/[\\%_]/g, (ch) => `\\${ch}`);
  return db
    .prepare(`
      SELECT e.id, e.name, e.role, l.name AS location
      FROM employees e JOIN locations l ON l.id = e.location_id
      WHERE e.id = :asId OR e.name LIKE '%' || :literal || '%' ESCAPE '\\'
      ORDER BY e.name
      LIMIT 20`)
    .all({ asId, literal }) as { id: number; name: string; role: string; location: string }[];
}

export function employeeAttendance(
  db: DatabaseSync,
  p: Range & { employeeId: number; graceMinutes: number },
) {
  const summary = db
    .prepare(`
      SELECT COUNT(s.id) AS scheduled_shifts,
             SUM(c.shift_id IS NULL) AS no_shows,
             SUM(${MINUTES_LATE} > :graceMinutes) AS times_late,
             SUM(c.shift_id IS NOT NULL AND c.clock_out IS NULL) AS missed_clock_outs,
             ROUND(AVG(CASE WHEN ${MINUTES_LATE} > :graceMinutes THEN ${MINUTES_LATE} END), 1) AS avg_minutes_late
      FROM shifts s LEFT JOIN clock_events c ON c.shift_id = s.id
      WHERE s.employee_id = :employeeId AND ${IN_RANGE}`)
    .get(p);

  // One row per problem shift. A shift can be late AND missing its clock-out, so each flag is separate.
  const rows = db
    .prepare(`
      SELECT s.scheduled_start, c.clock_in, c.clock_out,
             c.shift_id IS NULL AS no_show,
             CASE WHEN ${MINUTES_LATE} > :graceMinutes THEN ${MINUTES_LATE} END AS minutes_late,
             c.shift_id IS NOT NULL AND c.clock_out IS NULL AS missed_clock_out
      FROM shifts s LEFT JOIN clock_events c ON c.shift_id = s.id
      WHERE s.employee_id = :employeeId AND ${IN_RANGE}
        AND (c.shift_id IS NULL OR ${MINUTES_LATE} > :graceMinutes OR c.clock_out IS NULL)
      ORDER BY s.scheduled_start`)
    .all(p) as { scheduled_start: string; clock_in: string | null; clock_out: string | null;
      no_show: number; minutes_late: number | null; missed_clock_out: number }[];

  const incidents = rows.map(({ no_show, missed_clock_out, ...row }) => ({
    ...row,
    types: [
      ...(no_show ? ["no_show"] : []),
      ...(row.minutes_late !== null ? ["late"] : []),
      ...(missed_clock_out ? ["missed_clock_out"] : []),
    ],
  }));

  return { summary, incidents };
}

const BUCKETS = {
  weekday: "CASE strftime('%w', s.scheduled_start) WHEN '0' THEN '7 Sun' WHEN '1' THEN '1 Mon' WHEN '2' THEN '2 Tue' WHEN '3' THEN '3 Wed' WHEN '4' THEN '4 Thu' WHEN '5' THEN '5 Fri' ELSE '6 Sat' END",
  // Step back 6 days, then forward to the next Monday: lands on this week's Monday, including for Mondays.
  week: "date(s.scheduled_start, '-6 days', 'weekday 1')",
} as const;

export function locationTrends(
  db: DatabaseSync,
  p: Range & { location: string | null; groupBy: keyof typeof BUCKETS; graceMinutes: number },
) {
  // groupBy is an enum validated by the tool schema, so this interpolation is a fixed string.
  const bucket = BUCKETS[p.groupBy];
  // A week bucket is partial when the requested range cuts into it.
  const partial = p.groupBy === "week" ? `(${bucket} < :from OR date(${bucket}, '+6 days') > :to)` : "NULL";
  const { groupBy: _, ...params } = p;
  const rows = db
    .prepare(`
      SELECT l.name AS location, ${bucket} AS bucket,
             COUNT(s.id) AS scheduled_shifts,
             SUM(c.shift_id IS NULL) AS no_shows,
             COUNT(c.shift_id) AS attended_shifts,
             SUM(${MINUTES_LATE} > :graceMinutes) AS times_late,
             ROUND(100.0 * SUM(${MINUTES_LATE} > :graceMinutes) / COUNT(c.shift_id), 1) AS late_rate_pct,
             ${partial} AS partial_week
      FROM shifts s
      LEFT JOIN clock_events c ON c.shift_id = s.id
      JOIN locations l ON l.id = s.location_id
      WHERE ${IN_RANGE} AND ${AT_LOCATION}
      GROUP BY l.id, bucket
      ORDER BY l.name, bucket`)
    .all(params) as Record<string, unknown>[];
  return rows.map(({ partial_week, ...row }) =>
    p.groupBy === "week" ? { ...row, partial_week: partial_week === 1 } : row);
}

export function missingClockEvents(
  db: DatabaseSync,
  p: Range & { location: string | null; type: "no_show" | "missed_clock_out" | "all"; limit: number },
) {
  return db
    .prepare(`
      SELECT e.id AS employee_id, e.name AS employee, l.name AS location, s.scheduled_start,
             CASE WHEN c.shift_id IS NULL THEN 'no_show' ELSE 'missed_clock_out' END AS type
      FROM shifts s
      LEFT JOIN clock_events c ON c.shift_id = s.id
      JOIN employees e ON e.id = s.employee_id
      JOIN locations l ON l.id = s.location_id
      WHERE ${IN_RANGE} AND ${AT_LOCATION}
        AND (
          (:type IN ('no_show', 'all') AND c.shift_id IS NULL) OR
          (:type IN ('missed_clock_out', 'all') AND c.shift_id IS NOT NULL AND c.clock_out IS NULL)
        )
      ORDER BY s.scheduled_start
      LIMIT :limit`)
    .all(p);
}
