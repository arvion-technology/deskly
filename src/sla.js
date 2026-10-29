/**
 * The SLA clock.
 *
 * An SLA is not a countdown from `createdAt` in wall-clock minutes. It is a
 * countdown in *business minutes* within a support calendar, and it pauses
 * whenever the ticket is waiting on the customer. This module implements exactly
 * those two ideas and nothing else:
 *
 *   businessMinutesBetween(a, b, calendar)   minutes of open time in [a, b)
 *   addBusinessMinutes(start, n, calendar)   the instant n business minutes later
 *   evaluateSla(ticket, { now, calendar })   targets, remaining time, state
 *
 * Ticket state comes from `history`, so pause windows are reconstructed rather
 * than stored twice. The clock is always injected (`now`), which is what lets
 * the tests stand at 17:59 on a Friday and at 09:00 on Monday without waiting.
 *
 * Limitation, stated in the README: the calendar uses a fixed UTC offset per
 * workspace, not an IANA zone with DST rules. Nepal (UTC+05:45) has no DST, so
 * the demo is correct; a workspace in a DST zone should pass a zone-aware
 * calendar instead.
 */

import { PAUSE_STATUSES, firstAgentReply, getPolicy, resolvedAt } from "./model.js";

export const MINUTE = 60_000;
export const DAY = 86_400_000;

/**
 * Weekday keys are ISO: Monday = 1 … Sunday = 7. Each value is a list of
 * [openMinute, closeMinute) windows measured from local midnight. Two windows
 * means a lunch break; no windows means closed.
 */
export const WEEKDAY_HOURS = Object.freeze({
  1: [[540, 1080]],
  2: [[540, 1080]],
  3: [[540, 1080]],
  4: [[540, 1080]],
  5: [[540, 1080]],
  6: [[600, 840]],
  7: [],
});

export function createCalendar({ offsetMinutes = 345, hours = WEEKDAY_HOURS, holidays = [] } = {}) {
  if (!Number.isFinite(offsetMinutes) || Math.abs(offsetMinutes) > 840) {
    throw new RangeError("offsetMinutes must be a plausible UTC offset");
  }
  const normalised = {};
  for (const [weekday, windows] of Object.entries(hours)) {
    const key = Number(weekday);
    if (key < 1 || key > 7) throw new RangeError(`weekday out of range: ${weekday}`);
    const list = windows.map(([start, end]) => {
      if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end > 1440 || end <= start) {
        throw new RangeError(`invalid business window ${weekday}: ${start}-${end}`);
      }
      return [start, end];
    });
    normalised[key] = list;
  }
  return { offsetMinutes, hours: normalised, holidays: [...holidays].sort() };
}

export const DEFAULT_CALENDAR = createCalendar();

function localParts(instant, calendar) {
  const local = instant + calendar.offsetMinutes * MINUTE;
  const dayIndex = Math.floor(local / DAY);
  const minuteOfDay = Math.floor((local - dayIndex * DAY) / MINUTE);
  const dayStart = new Date(dayIndex * DAY);
  const dateKey = dayStart.toISOString().slice(0, 10);
  const weekday = ((dayStart.getUTCDay() + 6) % 7) + 1;
  return { dayIndex, minuteOfDay, dateKey, weekday };
}

function windowsFor(dayIndex, weekday, dateKey, calendar) {
  if (calendar.holidays.includes(dateKey)) return [];
  return calendar.hours[weekday] || [];
}

/** Open business minutes between two instants. Half-open: [start, end). */
export function businessMinutesBetween(start, end, calendar = DEFAULT_CALENDAR) {
  if (!Number.isFinite(start) || !Number.isFinite(end)) throw new TypeError("instants must be numbers");
  if (end <= start) return 0;
  const from = localParts(start, calendar);
  const to = localParts(end, calendar);
  let total = 0;

  for (let day = from.dayIndex; day <= to.dayIndex; day += 1) {
    if (day - from.dayIndex > 3_660) break; // ten years: a guard, not a feature
    const dayStart = new Date(day * DAY);
    const dateKey = dayStart.toISOString().slice(0, 10);
    const weekday = ((dayStart.getUTCDay() + 6) % 7) + 1;
    for (const [open, close] of windowsFor(day, weekday, dateKey, calendar)) {
      const begin = day === from.dayIndex ? Math.max(open, from.minuteOfDay) : open;
      const finish = day === to.dayIndex ? Math.min(close, to.minuteOfDay) : close;
      if (finish > begin) total += finish - begin;
    }
  }
  return total;
}

/**
 * The instant reached after `minutes` open business minutes. Starts counting at
 * `start` if it is inside business hours, otherwise at the next opening.
 */
export function addBusinessMinutes(start, minutes, calendar = DEFAULT_CALENDAR) {
  if (!Number.isInteger(minutes) || minutes < 0) throw new RangeError("minutes must be a non-negative integer");
  if (minutes === 0) return start;
  const from = localParts(start, calendar);
  let remaining = minutes;

  for (let day = from.dayIndex; day <= from.dayIndex + 3_660; day += 1) {
    const dayStart = new Date(day * DAY);
    const dateKey = dayStart.toISOString().slice(0, 10);
    const weekday = ((dayStart.getUTCDay() + 6) % 7) + 1;
    for (const [open, close] of windowsFor(day, weekday, dateKey, calendar)) {
      const begin = day === from.dayIndex ? Math.max(open, from.minuteOfDay) : open;
      if (close <= begin) continue;
      const available = close - begin;
      if (available >= remaining) {
        return day * DAY + (begin + remaining) * MINUTE - calendar.offsetMinutes * MINUTE;
      }
      remaining -= available;
    }
  }
  throw new RangeError("SLA target exceeds ten years of business hours");
}

/** Is this instant inside the support calendar? */
export function isBusinessTime(instant, calendar = DEFAULT_CALENDAR) {
  const local = localParts(instant, calendar);
  return windowsFor(local.dayIndex, local.weekday, local.dateKey, calendar)
    .some(([open, close]) => local.minuteOfDay >= open && local.minuteOfDay < close);
}

/** When the next working window opens at or after `instant`. */
export function nextOpening(instant, calendar = DEFAULT_CALENDAR) {
  if (isBusinessTime(instant, calendar)) return instant;
  for (let minute = 0; minute <= 60 * 24 * 14; minute += 1) {
    const candidate = instant + minute * MINUTE;
    if (isBusinessTime(candidate, calendar)) return candidate;
  }
  return null;
}

/* ------------------------------------------------------------- pause logic */

/**
 * Reconstruct pause windows from the status history. Every entry into a
 * PAUSE_STATUS opens a window; the next non-pause status closes it. An open
 * window at `now` is still running.
 */
export function pausePeriods(ticket, now = Date.now()) {
  const history = [...(ticket.history || [])].sort((a, b) => a.at - b.at);
  const periods = [];
  let openAt = null;
  for (const entry of history) {
    if (PAUSE_STATUSES.includes(entry.status)) {
      if (openAt === null) openAt = entry.at;
    } else if (openAt !== null) {
      if (entry.at > openAt) periods.push({ start: openAt, end: entry.at });
      openAt = null;
    }
  }
  if (openAt !== null && now > openAt) periods.push({ start: openAt, end: now });
  return periods;
}

/** Business minutes spent waiting on the customer. */
export function pausedBusinessMinutes(ticket, now = Date.now(), calendar = DEFAULT_CALENDAR) {
  return pausePeriods(ticket, now)
    .reduce((sum, period) => sum + businessMinutesBetween(period.start, period.end, calendar), 0);
}

/**
 * Business minutes the ticket has been alive, excluding time spent paused.
 * Passing a `until` instant freezes the measurement (used for "time to first
 * reply" and "time to resolution").
 */
export function activeBusinessMinutes(ticket, until = Date.now(), calendar = DEFAULT_CALENDAR) {
  const created = ticket.createdAt;
  const end = Math.max(created, until);
  const total = businessMinutesBetween(created, end, calendar);
  const paused = pausePeriods(ticket, end)
    .reduce((sum, period) => {
      const start = Math.max(period.start, created);
      const finish = Math.min(period.end, end);
      return sum + businessMinutesBetween(start, finish, calendar);
    }, 0);
  return Math.max(0, total - paused);
}

/** Human duration for an absolute number of minutes. */
export function formatMinutes(minutes) {
  const abs = Math.abs(Math.round(minutes));
  const hours = Math.floor(abs / 60);
  const rest = abs % 60;
  if (hours >= 48) {
    const days = Math.floor(hours / 24);
    return `${days}d ${hours % 24}h`;
  }
  if (hours) return rest ? `${hours}h ${rest}m` : `${hours}h`;
  return `${rest}m`;
}

/** "42m left", "1h 5m over", or "paused". */
export function countdownLabel(target) {
  if (!target) return ", ";
  if (target.paused) return "paused";
  if (target.met) {
    return target.breached ? `met ${formatMinutes(target.elapsed - target.target)} late` : "met";
  }
  if (target.remaining <= 0) return `${formatMinutes(-target.remaining)} over`;
  return `${formatMinutes(target.remaining)} left`;
}

function buildTarget({ target, elapsed, metAt, paused, now, calendar }) {
  const met = metAt !== null;
  const remaining = target - elapsed;
  const breached = met ? elapsed > target : remaining < 0;
  const dueAt = met || paused ? null : addBusinessMinutes(now, Math.max(0, remaining), calendar);
  return {
    target,
    elapsed,
    remaining,
    met,
    metAt,
    breached,
    paused,
    progress: target > 0 ? Math.min(1, elapsed / target) : 1,
    dueAt,
  };
}

/**
 * Evaluate both SLA targets for a ticket.
 *
 * State precedence: breached > paused > warning > met > ok.
 * `warning` starts when less than 25% of either budget remains.
 */
export function evaluateSla(ticket, { now = Date.now(), calendar = DEFAULT_CALENDAR, policy = null } = {}) {
  const rules = policy || getPolicy(ticket.priority);
  const replyAt = firstAgentReply(ticket);
  const doneAt = resolvedAt(ticket);
  const currentlyPaused = PAUSE_STATUSES.includes(ticket.status);

  const firstUntil = replyAt ?? now;
  const resolutionUntil = doneAt ?? now;
  const firstPaused = currentlyPaused && replyAt === null;
  const resolutionPaused = currentlyPaused && doneAt === null;

  const first = buildTarget({
    target: rules.firstResponseMinutes,
    elapsed: activeBusinessMinutes(ticket, firstUntil, calendar),
    metAt: replyAt,
    paused: firstPaused,
    now,
    calendar,
  });
  const resolution = buildTarget({
    target: rules.resolutionMinutes,
    elapsed: activeBusinessMinutes(ticket, resolutionUntil, calendar),
    metAt: doneAt,
    paused: resolutionPaused,
    now,
    calendar,
  });

  const warning = (first.remaining >= 0 && first.remaining / first.target <= 0.25)
    || (resolution.remaining >= 0 && resolution.remaining / resolution.target <= 0.25);

  let state;
  if (first.breached || resolution.breached) state = "breached";
  else if (currentlyPaused && !doneAt) state = "paused";
  else if (first.met && resolution.met) state = "met";
  else if (warning) state = "warning";
  else state = "ok";

  const dueTimes = [first.dueAt, resolution.dueAt].filter((value) => value !== null);

  return {
    policy: rules,
    state,
    first,
    resolution,
    pausedMinutes: pausedBusinessMinutes(ticket, now, calendar),
    nextBreachAt: dueTimes.length ? Math.min(...dueTimes) : null,
    atRisk: state === "warning" || state === "breached",
  };
}

/** Worst state across a list of evaluated tickets. */
export function worstSlaState(evaluations) {
  const rank = { breached: 5, warning: 4, paused: 3, ok: 2, met: 1 };
  return evaluations.reduce((worst, evaluation) =>
    (rank[evaluation.state] || 0) > (rank[worst] || 0) ? evaluation.state : worst, "met");
}
