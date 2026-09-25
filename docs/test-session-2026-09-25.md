# Attendance MCP: live test session, 2026-09-25

Tested from a Claude Code session against the running `attendance` MCP server (the stdio server in this folder, seeded data 2026-07-27 to 2026-09-20, 4 sites × 10 staff). All six tools were called for real. Three bugs are confirmed against the source.

## Verdict

- **Answers are correct.** Every planted pattern in `src/seed.ts` (`PLANTED`) came back through the tools.
- **Three bugs to fix**: week buckets, the incident type masking missed clock-outs, and silent empty results on bad input.
- **One design gap**: no per-person ranking for no-shows or missed clock-outs.

## Planted patterns vs what the tools returned

| Planted | Tool used | Result | Pass |
|---|---|---|---|
| Ryan Hughes, Manchester, chronic late (60%) | `repeat_late_arrivals` location=Manchester | 24/40 late, 60%, avg 22.8 min. Next person is 18.4% | ✅ |
| Belfast late on Mondays (50% chance) | `location_trends` group_by=weekday | Belfast Mon 35.7% (20/56). Other Belfast days 3–11%. Spread across staff, not one person | ✅ |
| Grace Doyle, Dublin, no-shows | `missing_clock_events` type=no_show location=Dublin | 6 no-shows, the most in Dublin (next is 2) | ✅ (manual count, see gap) |
| Tom Brennan, Cork, forgets clock-out | `employee_attendance` employee=11 | summary: 17 missed clock-outs out of 40 shifts | ✅ |

## The original question (first prompt)

> Who's regularly late in Manchester, and does any site have a bad day of the week?

**Answer given:** Ryan Hughes (60% late, 24/40, avg 22.8 min) is the outlier. Behind him are Oisin Doyle (18.4%, but the worst when late at ~30 min), Tom Ryan (15.4%) and Conor Nolan (12.5%). The bad day is **Belfast on Mondays at 35.7% late** vs 3–11% on its other days, spread across the site's staff, so it looks structural (start time, rota, transport). Dublin Tue 14.3% and Cork Wed 12.5% are probably noise. Manchester is flat at 11–16% by day because its problem is one person.

Tools: `repeat_late_arrivals` (Manchester, then Belfast min_times_late=2) and `location_trends` weekday, all sites.

## Every call made

| # | Tool | Input | Result | OK |
|---|---|---|---|---|
| 1 | repeat_late_arrivals | location=Manchester | 7 people, Ryan Hughes top | ✅ |
| 2 | location_trends | group_by=weekday (all sites) | 28 rows, Belfast Mon spike | ✅ |
| 3 | repeat_late_arrivals | location=Belfast, min_times_late=2 | 9 people, 7.5–17.9%, no outlier | ✅ |
| 4 | list_locations | none | 4 sites, tz, headcount 10, data range 07-27 to 09-20 | ✅ |
| 5 | employee_attendance | "Ryan Hughes" | 40 shifts, 24 late, 2 missed clock-outs, 24 incidents | ⚠️ bug 2 |
| 6 | employee_attendance | "Brennan" (ambiguous) | `ambiguous: true` + 4 candidates with id/role/site | ✅ |
| 7 | find_late_arrivals | limit=10 | Worst first, 40 min top (data caps at 40) | ✅ |
| 8 | missing_clock_events | limit=15 | Chronological mix of no_show / missed_clock_out | ✅ |
| 9 | employee_attendance | "25", from=2026-09-01 | Sofia Brennan by ID, range respected (14 shifts) | ✅ |
| 10 | employee_attendance | "Nobody McFakename" | Clean error: `No employee matches` | ✅ |
| 11 | find_late_arrivals | location=Narnia | `[]` silently | ❌ bug 3 |
| 12 | find_late_arrivals | location=belfast (lowercase), single day, min=1 | 3 rows, case-insensitive works, min_minutes_late=1 includes a 2-min arrival | ✅ |
| 13 | repeat_late_arrivals | from=09-20, to=07-27 (reversed) | `[]` silently | ❌ bug 3 |
| 14 | location_trends | Belfast, group_by=week | First bucket 2026-07-20 with 7 shifts, last week 43 | ❌ bug 1 |
| 15 | repeat_late_arrivals | Manchester, grace_minutes=15 | Ryan drops to 17/40 (42.5%), list shrinks to 4. Grace param works | ✅ |
| 16 | missing_clock_events | missed_clock_out, Manchester | 6 rows, filter works | ✅ |
| 17 | find_late_arrivals | from=2027-01-01 (outside data) | `[]` silently | ⚠️ bug 3 |
| 18 | missing_clock_events | no_show, Dublin | 17 rows, Grace Doyle ×6 | ✅ |
| 19 | employee_attendance | "11" | Tom Brennan, summary 17 missed clock-outs, 16 typed as such | ❌ bug 2 |

## Bugs

### Bug 1: week buckets put every Monday in the previous week
`src/queries.ts:115`

```ts
week: "date(s.scheduled_start, 'weekday 1', '-7 days')",
```

SQLite's `weekday 1` leaves a Monday unchanged, so `-7 days` then moves Monday shifts back a full week. Tuesday–Sunday land correctly.

Evidence: data starts Monday 2026-07-27, yet Belfast weekly output has a `2026-07-20` bucket with 7 shifts (that Monday's shifts), and the final week shows 43 shifts instead of 50 (7 + 43 = 50).

Why it matters: the planted pattern *is* a Monday effect, so weekly trends shift Belfast's Monday lateness into the wrong week. The `weekly_attendance_review` prompt (`src/server.ts:120`) asks for a week by its Monday, which makes it hit this directly.

Fix: `date(s.scheduled_start, '-6 days', 'weekday 1')`. Worth a test asserting a Monday shift buckets to its own date.

### Bug 2: late + missed clock-out shows only as "late"
`src/queries.ts:~98–106`, the `employee_attendance` incident `CASE`

The `CASE` checks late before `clock_out IS NULL`, so a shift that was both late and never clocked out only gets `type: "late"`. The summary still counts it as a missed clock-out, so summary and incident list disagree.

Evidence:
- Tom Brennan: summary says 17 missed clock-outs, but only 16 incidents are typed `missed_clock_out`. The 2026-08-28 shift is `late` with `clock_out: null`.
- Ryan Hughes: summary says 2 missed clock-outs, but zero incidents are typed that way (2026-08-22 and 2026-09-11 are `late` with `clock_out: null`).

Fix: return a list of types (`["late", "missed_clock_out"]`) or add a separate `missed_clock_out: boolean` field.

### Bug 3: bad input returns `[]` instead of an error
Affects `find_late_arrivals`, `repeat_late_arrivals`, `location_trends` and `missing_clock_events`.

- Unknown site (`Narnia`) returns `[]`, which reads as "nobody was late". The model will report that as fact.
- A reversed date range (`from` after `to`) returns `[]`.
- A range fully outside the data (2027) returns `[]`, with no hint that data ends 2026-09-20.

`employee_attendance` already does this right ("No employee matches…"). Fix by mirroring it: validate `location` against the sites table (and list valid names), reject `from > to`, and say when a range falls outside `data_range`.

## Design gap (not a bug)

**No ranking for no-shows or missed clock-outs.** `repeat_late_arrivals` ranks lateness per person, but nothing ranks no-shows or missed clock-outs. To find Grace Doyle I had to count names in a 17-row list. Tom Brennan only surfaced because I already knew to look him up. On a real dataset with the default limit of 100 this won't scale. Suggest a `repeat_missing_clock_events` tool (or a `group_by: "employee"` option on `missing_clock_events`) returning count + rate per person.

## Worked well

- Tool descriptions steered tool choice correctly on the first try ("regularly late" → `repeat_late_arrivals`, "bad day of the week" → `location_trends`).
- Ambiguous name handling returns candidates with role + site, so the model can ask the right question.
- ID vs name lookup, case-insensitive site names, date filters and `grace_minutes` all behave.
- Output is compact and easy to reason over. Overnight shifts (16:00 → 00:00) are handled correctly.

## Next steps

1. Fix bug 1 (a one-line change) and add a test.
2. Fix bug 2 (incident type).
3. Add input validation (bug 3).
4. Decide on the no-show / missed-clock-out ranking tool.
5. Re-run this session's call list as a regression check.

## Fixes (same day)

| Finding | Fix | Regression test |
|---|---|---|
| Bug 1: Mondays bucketed into the previous week | `date(s.scheduled_start, '-6 days', 'weekday 1')` | every Belfast week starts on its own Monday, 8 weeks × 50 shifts |
| Bug 2: late + missed clock-out typed only as late | incidents now carry a `types` array (`no_show`, `late`, `missed_clock_out`) | incident count of `missed_clock_out` matches the summary |
| Bug 3: bad input returned `[]` | one shared check on every tool: unknown site (lists valid ones), reversed range, range outside the data (says where the data is) | three tests, one per case |
| Gap: no per-person ranking of no-shows / missed clock-outs | new tool `repeat_missing_clock_events` | ranks Grace Doyle first in Dublin, Tom Brennan first in Cork |

Writing the bug 3 test caught one more: `from=2027-01-01` alone reported "from is after to", naming a `to` the caller never sent. The out-of-range check now runs first.

Test suite: 12 → 18 tests, all passing.
