/**
 * CSAT reporting.
 *
 * A CSAT number is only meaningful next to its response rate. "4.8 out of 5"
 * from 6 replies out of 300 resolved tickets is not a 4.8-star support desk, so
 * every summary here returns the denominator and the rate together. Only
 * resolved and closed tickets are eligible; a survey that nobody answered is
 * counted as missing, not as a 0.
 */

export const CSAT_SCALE = [1, 2, 3, 4, 5];

export function eligibleTickets(tickets) {
  return tickets.filter((ticket) => ticket.status === "resolved" || ticket.status === "closed");
}

export function csatSummary(tickets) {
  const eligible = eligibleTickets(tickets);
  const responses = eligible.filter((ticket) => ticket.csat && Number.isFinite(ticket.csat.score));
  const distribution = CSAT_SCALE.map((score) => ({
    score,
    count: responses.filter((ticket) => Math.round(ticket.csat.score) === score).length,
  }));
  const total = responses.reduce((sum, ticket) => sum + ticket.csat.score, 0);
  const satisfied = responses.filter((ticket) => ticket.csat.score >= 4).length;
  const promoters = responses.filter((ticket) => Math.round(ticket.csat.score) === 5).length;
  const detractors = responses.filter((ticket) => Math.round(ticket.csat.score) <= 3).length;
  return {
    eligible: eligible.length,
    responses: responses.length,
    rate: eligible.length ? responses.length / eligible.length : 0,
    average: responses.length ? total / responses.length : null,
    satisfiedRate: responses.length ? satisfied / responses.length : null,
    distribution,
    promoters,
    detractors,
    score: responses.length ? Math.round(((satisfied / responses.length) * 100 + Number.EPSILON) * 10) / 10 : null,
  };
}

/** CSAT per agent, with the same denominator discipline. */
export function agentCsat(tickets, agents) {
  return agents.map((agent) => {
    const owned = tickets.filter((ticket) => ticket.assigneeId === agent.id);
    const summary = csatSummary(owned);
    return {
      agentId: agent.id,
      name: agent.name,
      initials: agent.initials || "?",
      resolved: summary.eligible,
      responses: summary.responses,
      rate: summary.rate,
      average: summary.average,
      satisfiedRate: summary.satisfiedRate,
    };
  }).sort((a, b) => (b.average ?? 0) - (a.average ?? 0) || b.responses - a.responses);
}

/**
 * Average CSAT per week, oldest first. Weeks are relative to `now`, so the
 * chart shifts with the clock instead of showing a fixed historical window.
 */
export function csatTrend(tickets, { weeks = 6, now = Date.now() } = {}) {
  const WEEK = 7 * 86_400_000;
  const currentWeekStart = now - ((now % WEEK) + WEEK) % WEEK;
  const rows = [];
  for (let offset = weeks - 1; offset >= 0; offset -= 1) {
    const start = currentWeekStart - offset * WEEK;
    const end = start + WEEK;
    const responses = tickets.filter((ticket) =>
      ticket.csat && ticket.csat.at >= start && ticket.csat.at < end);
    const total = responses.reduce((sum, ticket) => sum + ticket.csat.score, 0);
    rows.push({
      start,
      end,
      label: `W-${offset}`,
      responses: responses.length,
      average: responses.length ? total / responses.length : null,
    });
  }
  return rows;
}

/** The comments worth reading: low scores first, then the newest. */
export function csatComments(tickets, { limit = 4 } = {}) {
  return eligibleTickets(tickets)
    .filter((ticket) => ticket.csat && ticket.csat.comment)
    .sort((a, b) => a.csat.score - b.csat.score || b.csat.at - a.csat.at)
    .slice(0, limit)
    .map((ticket) => ({
      ticketId: ticket.id,
      number: ticket.number,
      subject: ticket.subject,
      score: ticket.csat.score,
      at: ticket.csat.at,
      comment: ticket.csat.comment,
    }));
}
