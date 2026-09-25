# Attendance MCP: live test session, run 2 (2026-09-25)

> Historical log, kept as written. Tool counts and line numbers refer to the code at the time of the session; see the Fixes section at the end for what changed.

Second live session against the running `attendance` MCP server, after the fixes from [run 1](test-session-2026-09-25.md). Same seeded data: 2026-07-27 to 2026-09-20, 4 sites × 10 staff, 1,600 scheduled shifts.

**87 tool calls** across all seven tools, in four blocks: regression of run 1, the new ranking tool, a site × parameter sweep, and edge cases plus realistic manager questions. Unit suite: 18/18 passing.

## Verdict

- **All four run-1 findings are fixed and hold up live.** Every one of the 19 run-1 calls was replayed. The three bugs no longer reproduce, and the new `repeat_missing_clock_events` tool ranks the planted people first.
- **Numbers reconcile across tools.** Every total I cross-checked (weekday vs week buckets, rankings vs incident lists, grace thresholds vs raw minutes) matches to the shift.
- **One new low-severity bug:** name search treats `%`, `_` and whitespace-only input as "match everyone".
- **Three small rough edges and one design gap**, listed below. Nothing here produces a wrong answer to a real manager's question.

| Result | Calls |
|---|---|
| ✅ Correct | 80 |
| ⚠️ Correct data, rough edge | 4 |
| ❌ Bug | 3 (one root cause) |

## Block A: regression of run 1 (19 calls)

| # | Tool | Input | Run 1 | Run 2 |
|---|---|---|---|---|
| 1 | repeat_late_arrivals | Manchester | ✅ | ✅ Ryan Hughes 24/40, 60%, avg 22.8 |
| 2 | location_trends | weekday, all sites | ✅ | ✅ Belfast Mon 35.7% (20/56) |
| 3 | repeat_late_arrivals | Belfast, min 2 | ✅ | ✅ 9 people, 7.5–17.9%, no outlier |
| 4 | list_locations | none | ✅ | ✅ |
| 5 | employee_attendance | "Ryan Hughes" | ⚠️ bug 2 | ✅ 08-22 and 09-11 now `["late","missed_clock_out"]` |
| 6 | employee_attendance | "Brennan" | ✅ | ✅ 4 candidates |
| 7 | find_late_arrivals | limit 10 | ✅ | ✅ |
| 8 | missing_clock_events | limit 15 | ✅ | ✅ |
| 9 | employee_attendance | "25", from 09-01 | ✅ | ✅ 14 shifts |
| 10 | employee_attendance | "Nobody McFakename" | ✅ | ✅ clean error |
| 11 | find_late_arrivals | location Narnia | ❌ bug 3 | ✅ `Unknown location "Narnia". Valid locations: …` |
| 12 | find_late_arrivals | belfast, one day, min 1 | ✅ | ✅ case-insensitive |
| 13 | repeat_late_arrivals | reversed range | ❌ bug 3 | ✅ `"from" (2026-09-20) is after "to" (2026-07-27).` |
| 14 | location_trends | Belfast, week | ❌ bug 1 | ✅ 8 buckets, each starts on its own Monday, 50 shifts each |
| 15 | repeat_late_arrivals | Manchester, grace 15 | ✅ | ✅ Ryan 17/40, 42.5% |
| 16 | missing_clock_events | missed_clock_out, Manchester | ✅ | ✅ 6 rows |
| 17 | find_late_arrivals | from 2027-01-01 | ⚠️ bug 3 | ⚠️ errors correctly, but see rough edge R1 |
| 18 | missing_clock_events | no_show, Dublin | ✅ | ✅ 17 rows, Grace Doyle ×6 |
| 19 | employee_attendance | "11" | ❌ bug 2 | ✅ 17 incidents typed `missed_clock_out` = summary 17 |

## Block B: the new `repeat_missing_clock_events` tool (7 calls)

| Input | Result | OK |
|---|---|---|
| defaults (min 3), all sites | Tom Brennan 17 missed clock-outs (42.5%), Grace Doyle 6 no-shows (15%), then Grace Moore and Adam Nolan with 3 missed clock-outs each | ✅ |
| Dublin, min 2 | Grace Doyle first; next person has 2 no-shows | ✅ |
| Cork, min 2 | Tom Brennan first by a wide margin | ✅ |
| Belfast, min 2 | 4 people, top is 3 events. No outlier | ✅ |
| Manchester, min 2 | 4 people, top is 3 events. Ryan Hughes shows his 2 missed clock-outs | ✅ |
| location Atlantis | `Unknown location` error with valid names | ✅ |
| from 09-01, min 2 | Only Tom Brennan, 7/14 missed clock-outs (50%) | ✅ |

Sort order is total events, descending. The "at least N of either" threshold works as described (Grace Moore makes the default list on 3 missed clock-outs alone).

## Block C: sweep and cross-checks (40 calls)

Every site through every ranking and list tool, weekly trends for all four sites, grace at 0/15/30/60, `min_minutes_late` at 1/30/41, date edges and out-of-bounds parameters.

**Reconciliation checks (all pass):**

- Weekly and weekday buckets sum to the same totals for every site (for example Belfast: 43 late, 9 no-shows, 400 shifts either way).
- Rows in `missing_clock_events` match the counts in the rankings and trends: Dublin 17 no-shows, Cork 10, Belfast 9 no-shows + 5 missed clock-outs, Manchester 6 missed clock-outs.
- The grace thresholds line up with the raw minutes: at grace 30, Sofia Moore's lates are 39/31/31, giving an average of 33.7. Grace Moore's 30-minute arrival is correctly excluded (late means more than grace minutes), and correctly included by `find_late_arrivals` with `min_minutes_late=30` (at least that many).
- `min_minutes_late=41` and `grace_minutes=60` return `[]`. This is correct: the data tops out at 40 minutes.

**Input handling that works:**

- Schema rejects `limit` 0 and 201, `grace_minutes` −5 and 61, `from: "20-09-2026"`, `group_by: "month"`, `type: "late"` and an empty `employee`, each with a precise message.
- A SQL injection string in `employee` is harmless (the query is parameterised).
- Leading and trailing spaces are trimmed on names and sites (`"  Ryan Hughes  "`, `"cork "`).
- Ranges that partly overlap the data are clipped to it (07-01..07-28 returns 07-28 rows).
- Single days at both ends of the data work (07-27 and 09-20).

**Interesting result for the demo:** at `grace_minutes=0`, Grace Moore (Dublin) is "late" on 42% of shifts, but by only 3.8 minutes on average. The grace setting changes who looks like a problem, which is exactly why it's a parameter.

## Block D: realistic manager questions (8 calls)

**"Is Belfast's Monday problem getting better?"**
No. It's identical in both halves of the period: 10/28 Mondays late (35.7%) from 27 Jul to 23 Aug, and 10/28 again from 24 Aug to 20 Sep. Every other day stays at 0–14%. It's steady and structural, not a phase.
*(location_trends weekday, Belfast, two date ranges)*

**"Is Ryan Hughes getting worse?"**
Slightly: 55% late (11/20) in the first four weeks, 65% (13/20) in the last four, with the average stuck at ~23 minutes. The one to watch behind him is Oisin Doyle, up from 10.5% to 26.3% and the worst when late (~30 min).
*(repeat_late_arrivals, Manchester, two date ranges)*

**"How did Dublin do last week?"** (14–20 Sep)
Quiet. One late arrival past grace (Grace Doyle, 17 min on the 15th), no no-shows, one missed clock-out (Grace Moore, 18th). Grace Doyle turned up for every shift that week; her last no-show was 6 Sep.
*(find_late_arrivals + missing_clock_events, Dublin, one week)*

**"Who do I need to talk to in Cork?"** (from 7 Sep)
Tom Brennan: 6 missed clock-outs in 10 shifts (60%), up from 42.5% over the whole period. Nobody else has more than one event.
*(repeat_missing_clock_events, Cork, min 1)*

**"How did every site do last week?"**
Cork and Dublin at 2% late, Belfast and Manchester at 8%. One no-show across all four sites (Cork).
*(location_trends week, from 09-14)*

## Findings

### Bug: name search treats `%`, `_` and whitespace-only input as "everyone"
`src/queries.ts:102`, `src/server.ts:99`

```sql
WHERE e.id = :asId OR e.name LIKE '%' || :query || '%'
```

The query goes into `LIKE` unescaped, so `%` and `_` act as wildcards. `"   "` passes the schema's `minLength: 1`, is trimmed to `""`, and becomes `LIKE '%%'`. All three return `ambiguous: true` with all 40 employees (name, role, site).

Impact is low: it's the same data the other tools expose. But it's wrong (a search for `%` should match nobody), and a real directory would return a very large candidate list. Fix: escape `%`/`_` and add `ESCAPE '\'`, and reject an empty string after trimming.

### R1: out-of-range error names a bound the caller never sent
`from=2027-01-01` → `No data in 2027-01-01 to 2026-09-20.` and `to=2026-06-30` → `No data in 2026-07-27 to 2026-06-30.`

The check is right, but the message fills in the missing side with the data edge, producing a backwards range. This is the same family as the fix noted in run 1. Suggest: `No data from 2027-01-01. The data covers 2026-07-27 to 2026-09-20.`

### R2: `late_rate_pct` means two different things
`src/queries.ts:59` (inner join) vs `src/queries.ts:169` (left join)

`repeat_late_arrivals` divides by shifts actually worked (no-shows are excluded), while `location_trends` divides by scheduled shifts. So Oisin Doyle shows `shifts: 38` in one tool and 40 in `repeat_missing_clock_events` and `employee_attendance`. Both are defensible, but the same field name hides the difference. Pick one, or rename (`worked_shifts` / `late_rate_of_worked_pct`).

### R3: impossible dates are accepted
`from=2026-02-30` passes the `YYYY-MM-DD` regex and runs. It's harmless here because the dates are compared as strings, but a typo like `2026-09-31` won't be caught. A `Date` round-trip check in the shared validator would fix it.

### Design gap: partial weeks aren't flagged
With `group_by: "week"` and a range starting midweek (09-02..09-09), the first bucket is labelled `2026-08-31` but holds only Wed–Sun (35 shifts, 0% late), and the last holds Mon–Wed (22 shifts, 27.3%). A model could compare them as whole weeks. Suggest adding `partial: true` or explicit bucket `from`/`to` dates.

## Worked well

- Every planted pattern surfaces through the intended tool on the first try, and holds when the period is split in half.
- The error messages now steer the model: unknown sites list the valid ones and out-of-range queries say where the data is.
- The `types` array makes overlapping incidents readable (late and unclosed on the same shift).
- Schema validation is tight and the messages are specific.
- Output stays compact enough to reason over, even at `limit: 200`.

## Next steps

1. Escape `LIKE` wildcards and reject empty-after-trim names, with a test for each.
2. Reword the one-sided out-of-range message (R1).
3. Decide on the `late_rate_pct` definition (R2).
4. Optional: calendar-date validation (R3) and `partial` week flags.

## Fixes (same day)

| Finding | Fix | Regression test |
|---|---|---|
| `%`, `_` or blank name search matched all 40 employees | `%` and `_` escaped (`LIKE … ESCAPE '\'`); a blank search is an error | `%`, `_`, `a%` and `"   "` all return errors |
| One-sided out-of-range error read backwards | message names only what was asked: "No data from 2027-01-01 onwards" / "No data up to …" | both directions |
| `late_rate_pct` meant two things | one definition everywhere: late ÷ attended shifts. Ranking column renamed `attended_shifts`; site trends now return `scheduled_shifts`, `no_shows`, `attended_shifts` | rate recomputed from its own columns in both tools |
| Impossible dates (2026-02-30) accepted | date schema checks it's a real calendar date | 2026-02-30 rejected |
| Partial weeks unmarked | weekly rows carry `partial_week` | a midweek range marks first and last weeks partial |

Knock-on: site-level late rates are now over attended shifts, so the Belfast Monday figure moves slightly: first four weeks 37.0% (10 of 27 attended, one no-show), last four weeks 35.7% (10 of 28). Same conclusion: not improving. Test suite: 18 → 24, all passing.
