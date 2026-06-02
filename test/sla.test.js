import test from "node:test";
import assert from "node:assert/strict";

import {
  DAY, MINUTE, createCalendar, DEFAULT_CALENDAR, businessMinutesBetween, addBusinessMinutes,
  isBusinessTime, nextOpening, pausePeriods, pausedBusinessMinutes, activeBusinessMinutes,
  evaluateSla, countdownLabel, formatMinutes, worstSlaState,
} from "../src/sla.js";

// Monday 26 October 2026, 09:00 UTC.
const MONDAY = Date.UTC(2026, 9, 26, 9, 0);
const cal = (overrides = {}) => createCalendar({
  offsetMinutes: 0,
  hours: { 1: [[540, 1080]], 2: [[540, 1080]], 3: [[540, 1080]], 4: [[540, 1080]], 5: [[540, 1080]], 6: [], 7: [] },
  holidays: [],
  ...overrides,
});
const lunch = createCalendar({
  offsetMinutes: 0,
  hours: { 1: [[540, 720], [780, 1080]], 2: [[540, 720], [780, 1080]], 3: [[540, 720], [780, 1080]], 4: [[540, 720], [780, 1080]], 5: [[540, 720], [780, 1080]], 6: [], 7: [] },
});

function ticket(overrides = {}) {
  return {
    id: "t1", priority: "urgent", status: "open", createdAt: MONDAY,
    history: [{ status: "new", at: MONDAY }, { status: "open", at: MONDAY + 2 * MINUTE }],
    messages: [],
    ...overrides,
  };
}

test("a calendar validates its windows instead of trusting input", () => {
  assert.throws(() => createCalendar({ offsetMinutes: 9999 }), RangeError);
  assert.throws(() => createCalendar({ hours: { 1: [[600, 500]] } }), RangeError);
  assert.throws(() => createCalendar({ hours: { 8: [[540, 1080]] } }), RangeError);
  assert.equal(DEFAULT_CALENDAR.offsetMinutes, 345);
});

test("business minutes count partial days, lunch breaks and weekends", () => {
  assert.equal(businessMinutesBetween(MONDAY, MONDAY + 8 * 60 * MINUTE, cal()), 480, "09:00–17:00");
  assert.equal(businessMinutesBetween(MONDAY, MONDAY + 9 * 60 * MINUTE, cal()), 540, "closes at 18:00");
  assert.equal(businessMinutesBetween(MONDAY + 120 * MINUTE, MONDAY + 5 * 60 * MINUTE, lunch), 120, "two hours, splitting the lunch break");
  const friday5pm = Date.UTC(2026, 9, 30, 17, 0);
  const monday10am = Date.UTC(2026, 10, 2, 10, 0);
  assert.equal(businessMinutesBetween(friday5pm, monday10am, cal()), 120, "one Friday hour plus one Monday hour");
  assert.equal(businessMinutesBetween(monday10am, friday5pm, cal()), 0, "reverse intervals are zero");
});

test("holidays are closed, not just weekends", () => {
  const withHoliday = cal({ holidays: ["2026-10-26"] });
  assert.equal(businessMinutesBetween(MONDAY, MONDAY + 8 * 60 * MINUTE, withHoliday), 0);
  const tuesday = Date.UTC(2026, 9, 27, 9, 0);
  assert.equal(businessMinutesBetween(MONDAY, tuesday + 8 * 60 * MINUTE, withHoliday), 480);
});

test("addBusinessMinutes crosses closing time and weekends", () => {
  const monday4pm = MONDAY + 7 * 60 * MINUTE;
  assert.equal(addBusinessMinutes(monday4pm, 120, cal()), MONDAY + 9 * 60 * MINUTE, "16:00 + 2h = 18:00");
  assert.equal(addBusinessMinutes(monday4pm, 150, cal()), Date.UTC(2026, 9, 27, 9, 30), "16:00 + 2.5h = Tuesday 09:30");
  const friday4pm = Date.UTC(2026, 9, 30, 16, 0);
  assert.equal(addBusinessMinutes(friday4pm, 180, cal()), Date.UTC(2026, 10, 2, 10, 0), "Friday + 2h, then 1h on Monday = 10:00");
  assert.equal(addBusinessMinutes(MONDAY - 120 * MINUTE, 60, cal()), MONDAY + 60 * MINUTE, "before opening waits for 09:00");
  assert.equal(addBusinessMinutes(MONDAY, 0, cal()), MONDAY);
});

test("business time predicates and next opening", () => {
  assert.equal(isBusinessTime(MONDAY + 60 * MINUTE, cal()), true);
  assert.equal(isBusinessTime(MONDAY + 12 * 60 * MINUTE, cal()), false);
  assert.equal(nextOpening(MONDAY + 12 * 60 * MINUTE, cal()), Date.UTC(2026, 9, 27, 9, 0));
  assert.equal(nextOpening(MONDAY + 60 * MINUTE, cal()), MONDAY + 60 * MINUTE);
});

test("pause windows are reconstructed from status history", () => {
  const pausedTicket = ticket({
    status: "pending_customer",
    history: [
      { status: "new", at: MONDAY },
      { status: "open", at: MONDAY + 10 * MINUTE },
      { status: "pending_customer", at: MONDAY + 60 * MINUTE },
    ],
  });
  const now = MONDAY + 120 * MINUTE;
  assert.deepEqual(pausePeriods(pausedTicket, now), [{ start: MONDAY + 60 * MINUTE, end: now }]);
  assert.equal(pausedBusinessMinutes(pausedTicket, now, cal()), 60);
  assert.equal(activeBusinessMinutes(pausedTicket, now, cal()), 60, "only the first hour counted");
});

test("closed pause windows stop subtracting", () => {
  const resumed = ticket({
    history: [
      { status: "new", at: MONDAY },
      { status: "open", at: MONDAY + 10 * MINUTE },
      { status: "pending_customer", at: MONDAY + 60 * MINUTE },
      { status: "open", at: MONDAY + 90 * MINUTE },
    ],
  });
  assert.equal(pausedBusinessMinutes(resumed, MONDAY + 180 * MINUTE, cal()), 30);
  assert.equal(activeBusinessMinutes(resumed, MONDAY + 180 * MINUTE, cal()), 150);
});

test("evaluateSla reports remaining time and a warning threshold", () => {
  const now = MONDAY + 20 * MINUTE;
  const evaluation = evaluateSla(ticket(), { now, calendar: cal() });
  assert.equal(evaluation.state, "ok");
  assert.equal(evaluation.first.target, 30);
  assert.equal(evaluation.first.elapsed, 20);
  assert.equal(evaluation.first.remaining, 10);
  assert.equal(evaluation.first.met, false);
  assert.equal(evaluation.first.breached, false);
  assert.equal(evaluation.nextBreachAt, now + 10 * MINUTE);

  const nearlyDue = evaluateSla(ticket(), { now: MONDAY + 27 * MINUTE, calendar: cal() });
  assert.equal(nearlyDue.state, "warning", "under 25% of the budget left");
});

test("an unanswered urgent ticket breaches its first-response target", () => {
  const evaluation = evaluateSla(ticket(), { now: MONDAY + 45 * MINUTE, calendar: cal() });
  assert.equal(evaluation.state, "breached");
  assert.equal(evaluation.first.breached, true);
  assert.equal(evaluation.first.remaining, -15);
  assert.equal(countdownLabel(evaluation.first), "15m over");
});

test("a paused ticket's resolution clock stops and does not breach", () => {
  const paused = ticket({
    status: "pending_customer",
    history: [
      { status: "new", at: MONDAY },
      { status: "open", at: MONDAY + 2 * MINUTE },
      { status: "pending_customer", at: MONDAY + 10 * MINUTE },
    ],
    messages: [
      { kind: "customer", authorId: "cu-1", at: MONDAY, body: "help" },
      { kind: "reply", authorId: "ag-1", at: MONDAY + 10 * MINUTE, body: "on it" },
    ],
  });
  const evaluation = evaluateSla(paused, { now: MONDAY + 300 * MINUTE, calendar: cal() });
  assert.equal(evaluation.state, "paused");
  assert.equal(evaluation.first.met, true);
  assert.equal(evaluation.resolution.paused, true);
  assert.equal(evaluation.resolution.elapsed, 10, "the clock stopped at the reply");
  assert.equal(evaluation.pausedMinutes, 290);
  assert.equal(countdownLabel(evaluation.resolution), "paused");
});

test("resolved tickets report whether each target was met", () => {
  const resolved = ticket({
    status: "resolved",
    history: [
      { status: "new", at: MONDAY },
      { status: "open", at: MONDAY + 2 * MINUTE },
      { status: "resolved", at: MONDAY + 40 * MINUTE },
    ],
    messages: [
      { kind: "customer", authorId: "cu-1", at: MONDAY, body: "help" },
      { kind: "reply", authorId: "ag-1", at: MONDAY + 20 * MINUTE, body: "fixed" },
    ],
  });
  const evaluation = evaluateSla(resolved, { now: MONDAY + 600 * MINUTE, calendar: cal() });
  assert.equal(evaluation.state, "met");
  assert.equal(evaluation.first.metAt, MONDAY + 20 * MINUTE);
  assert.equal(evaluation.resolution.metAt, MONDAY + 40 * MINUTE);
  assert.equal(evaluation.nextBreachAt, null);
});

test("a resolution after the deadline still counts as breached, even when met", () => {
  const nextDay = Date.UTC(2026, 9, 27, 14, 0);
  const slow = ticket({
    status: "resolved",
    history: [
      { status: "new", at: MONDAY },
      { status: "open", at: MONDAY + 2 * MINUTE },
      { status: "resolved", at: nextDay },
    ],
    messages: [
      { kind: "customer", authorId: "cu-1", at: MONDAY, body: "help" },
      { kind: "reply", authorId: "ag-1", at: MONDAY + 20 * MINUTE, body: "looking" },
    ],
  });
  const evaluation = evaluateSla(slow, { now: nextDay + 60 * MINUTE, calendar: cal() });
  assert.equal(evaluation.resolution.met, true);
  assert.equal(evaluation.resolution.breached, true);
  assert.equal(evaluation.state, "breached");
});

test("custom policies override the priority defaults", () => {
  const evaluation = evaluateSla(ticket(), {
    now: MONDAY + 10 * MINUTE,
    calendar: cal(),
    policy: { firstResponseMinutes: 5, resolutionMinutes: 60, pauseOnCustomer: false },
  });
  assert.equal(evaluation.first.breached, true);
  assert.equal(evaluation.policy.firstResponseMinutes, 5);
});

test("duration labels are readable", () => {
  assert.equal(formatMinutes(45), "45m");
  assert.equal(formatMinutes(60), "1h");
  assert.equal(formatMinutes(125), "2h 5m");
  assert.equal(formatMinutes(60 * 50), "2d 2h");
  assert.equal(countdownLabel({ paused: false, met: false, remaining: 65, target: 240, breached: false }), "1h 5m left");
  assert.equal(countdownLabel({ paused: false, met: true, target: 240, elapsed: 250, breached: true }), "met 10m late");
  assert.equal(worstSlaState([{ state: "ok" }, { state: "warning" }, { state: "met" }]), "warning");
});

test("long gaps inside the calendar are measured correctly across a week", () => {
  const nextMonday = MONDAY + 7 * DAY;
  assert.equal(businessMinutesBetween(MONDAY, nextMonday, cal()), 5 * 540);
});
