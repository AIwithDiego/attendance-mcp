import { DatabaseSync } from "node:sqlite";

// Synthetic data only. Every name, shift and clock event is generated here
// from a fixed seed, so the dataset (and the tests) are identical on every run.

export const DATA_START = "2026-07-27"; // a Monday
export const WEEKS = 8;

const LOCATIONS = [
  { name: "Dublin", country: "IE", timezone: "Europe/Dublin" },
  { name: "Cork", country: "IE", timezone: "Europe/Dublin" },
  { name: "Manchester", country: "UK", timezone: "Europe/London" },
  { name: "Belfast", country: "UK", timezone: "Europe/London" },
] as const;

const FIRST = ["Aoife", "Liam", "Sofia", "Conor", "Emma", "Jack", "Niamh", "Oisin", "Grace", "Tom",
  "Chloe", "Ryan", "Ella", "Sean", "Maya", "Adam", "Zara", "Luke", "Isla", "Dan"];
const LAST = ["Murphy", "Kelly", "Walsh", "Smith", "Byrne", "Ryan", "Clarke", "Doyle", "Brennan", "Hughes",
  "Lynch", "Patel", "Evans", "Moore", "Quinn", "Nolan"];
const ROLES = ["Floor staff", "Floor staff", "Floor staff", "Kitchen", "Kitchen", "Supervisor"];
const START_TIMES = ["07:00", "09:00", "12:00", "16:00"];
const EMPLOYEES_PER_LOCATION = 10;

// Planted patterns, so there is something real to find.
export const PLANTED = {
  chronicLate: "Ryan Hughes",      // Manchester: late on most shifts
  noShows: "Grace Doyle",          // Dublin: repeated no-shows
  missedClockOuts: "Tom Brennan",  // Cork: forgets to clock out
  mondayLateSite: "Belfast",       // whole site runs late on Mondays
} as const;

function mulberry32(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function addMinutes(date: string, time: string, minutes: number): string {
  const d = new Date(`${date}T${time}:00Z`);
  d.setUTCMinutes(d.getUTCMinutes() + minutes);
  return d.toISOString().slice(0, 16).replace("T", " ");
}

export function createDatabase(path = ":memory:"): DatabaseSync {
  const db = new DatabaseSync(path);
  db.exec(`
    CREATE TABLE IF NOT EXISTS locations (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      country TEXT NOT NULL,
      timezone TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS employees (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      role TEXT NOT NULL,
      location_id INTEGER NOT NULL REFERENCES locations(id)
    );
    -- Times are local to the location, as 'YYYY-MM-DD HH:MM'.
    CREATE TABLE IF NOT EXISTS shifts (
      id INTEGER PRIMARY KEY,
      employee_id INTEGER NOT NULL REFERENCES employees(id),
      location_id INTEGER NOT NULL REFERENCES locations(id),
      scheduled_start TEXT NOT NULL,
      scheduled_end TEXT NOT NULL
    );
    -- No row for a shift = no-show. clock_out NULL = missed clock-out.
    CREATE TABLE IF NOT EXISTS clock_events (
      shift_id INTEGER PRIMARY KEY REFERENCES shifts(id),
      clock_in TEXT NOT NULL,
      clock_out TEXT
    );
  `);

  const alreadySeeded = db.prepare("SELECT COUNT(*) AS n FROM locations").get() as { n: number };
  if (alreadySeeded.n === 0) seed(db);
  return db;
}

function seed(db: DatabaseSync): void {
  const rand = mulberry32(20260727);
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)]!;

  const insertLocation = db.prepare("INSERT INTO locations (name, country, timezone) VALUES (?, ?, ?)");
  const insertEmployee = db.prepare("INSERT INTO employees (name, role, location_id) VALUES (?, ?, ?)");
  const insertShift = db.prepare(
    "INSERT INTO shifts (employee_id, location_id, scheduled_start, scheduled_end) VALUES (?, ?, ?, ?)",
  );
  const insertClock = db.prepare("INSERT INTO clock_events (shift_id, clock_in, clock_out) VALUES (?, ?, ?)");

  db.exec("BEGIN");

  // Employees: planted people first so their names are guaranteed, the rest generated.
  const planted = new Map<string, string>([
    ["Manchester", PLANTED.chronicLate],
    ["Dublin", PLANTED.noShows],
    ["Cork", PLANTED.missedClockOuts],
  ]);
  const used = new Set<string>(planted.values());
  const staff: { id: number; name: string; locationId: number; location: string }[] = [];

  for (const loc of LOCATIONS) {
    const locationId = Number(insertLocation.run(loc.name, loc.country, loc.timezone).lastInsertRowid);
    for (let i = 0; i < EMPLOYEES_PER_LOCATION; i++) {
      let name = i === 0 ? planted.get(loc.name) : undefined;
      while (!name) {
        const candidate = `${pick(FIRST)} ${pick(LAST)}`;
        if (!used.has(candidate)) {
          used.add(candidate);
          name = candidate;
        }
      }
      const id = Number(insertEmployee.run(name, pick(ROLES), locationId).lastInsertRowid);
      staff.push({ id, name, locationId, location: loc.name });
    }
  }

  // Shifts: everyone works 5 days a week on a fixed pattern and start time.
  for (const [index, person] of staff.entries()) {
    const dayOff = index % 7;
    const startTime = pick(START_TIMES);

    for (let day = 0; day < WEEKS * 7; day++) {
      const weekday = day % 7; // 0 = Monday
      if (weekday === dayOff || weekday === (dayOff + 3) % 7) continue;

      const date = addDays(DATA_START, day);
      const start = `${date} ${startTime}`;
      const end = addMinutes(date, startTime, 8 * 60);
      const shiftId = Number(insertShift.run(person.id, person.locationId, start, end).lastInsertRowid);

      let noShowChance = 0.02;
      let lateChance = 0.08;
      let missedOutChance = 0.02;
      if (person.name === PLANTED.chronicLate) lateChance = 0.6;
      if (person.name === PLANTED.noShows) noShowChance = 0.18;
      if (person.name === PLANTED.missedClockOuts) missedOutChance = 0.4;
      if (person.location === PLANTED.mondayLateSite && weekday === 0) lateChance = 0.5;

      if (rand() < noShowChance) continue;

      const offset = rand() < lateChance
        ? 6 + Math.floor(rand() * 35)          // late: 6 to 40 minutes
        : -10 + Math.floor(rand() * 14);        // on time: 10 early to 3 late
      const clockIn = addMinutes(date, startTime, offset);
      const clockOut = rand() < missedOutChance
        ? null
        : addMinutes(date, startTime, 8 * 60 + Math.floor(rand() * 20) - 5);
      insertClock.run(shiftId, clockIn, clockOut);
    }
  }

  db.exec("COMMIT");
}
