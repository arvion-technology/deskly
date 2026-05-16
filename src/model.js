/**
 * Shared vocabulary for the helpdesk: priorities, statuses, SLA policies and
 * the two facts about a ticket that everything else derives from — when an
 * agent first replied publicly, and when the ticket was resolved.
 */

export const PRIORITIES = Object.freeze({
  urgent: { key: "urgent", label: "Urgent", rank: 4, tone: "red" },
  high: { key: "high", label: "High", rank: 3, tone: "gold" },
  normal: { key: "normal", label: "Normal", rank: 2, tone: "blue" },
  low: { key: "low", label: "Low", rank: 1, tone: "" },
});

export const PRIORITY_ORDER = ["urgent", "high", "normal", "low"];

export const STATES = Object.freeze({
  new: { key: "new", label: "New", tone: "blue", column: 0 },
  open: { key: "open", label: "Open", tone: "gold", column: 1 },
  pending_customer: { key: "pending_customer", label: "Pending customer", tone: "purple", column: 2 },
  pending_engineering: { key: "pending_engineering", label: "Engineering", tone: "blue", column: 3 },
  resolved: { key: "resolved", label: "Resolved", tone: "green", column: 4 },
  closed: { key: "closed", label: "Closed", tone: "", column: 5 },
});

export const STATE_ORDER = ["new", "open", "pending_customer", "pending_engineering", "resolved", "closed"];

/** The only status whose clock stops: the ball is in the customer's court. */
export const PAUSE_STATUSES = ["pending_customer"];

export function isOpen(status) {
  return status !== "resolved" && status !== "closed";
}

export function priorityLabel(priority) {
  return PRIORITIES[priority]?.label || "Normal";
}

export function priorityRank(priority) {
  return PRIORITIES[priority]?.rank || PRIORITIES.normal.rank;
}

/**
 * First-response and resolution targets, in *business minutes*. These are
 * targets, not guarantees; the SLA panel shows how much of each budget is gone.
 */
export const SLA_POLICIES = Object.freeze({
  urgent: { firstResponseMinutes: 30, resolutionMinutes: 240, pauseOnCustomer: true },
  high: { firstResponseMinutes: 60, resolutionMinutes: 480, pauseOnCustomer: true },
  normal: { firstResponseMinutes: 240, resolutionMinutes: 1_440, pauseOnCustomer: true },
  low: { firstResponseMinutes: 480, resolutionMinutes: 2_880, pauseOnCustomer: true },
});

export function getPolicy(priority) {
  return SLA_POLICIES[priority] || SLA_POLICIES.normal;
}

/** First public agent reply. Internal notes do not count. */
export function firstAgentReply(ticket) {
  const replies = (ticket.messages || [])
    .filter((message) => message.kind === "reply" && message.authorId !== ticket.customerId)
    .sort((a, b) => a.at - b.at);
  return replies.length ? replies[0].at : null;
}

/** The moment the ticket stopped counting against the resolution target. */
export function resolvedAt(ticket) {
  const entry = (ticket.history || [])
    .filter((row) => row.status === "resolved" || row.status === "closed")
    .sort((a, b) => a.at - b.at)[0];
  return entry ? entry.at : null;
}

/** Public messages only — what the customer actually saw. */
export function publicMessages(ticket) {
  return (ticket.messages || [])
    .filter((message) => message.kind !== "note")
    .sort((a, b) => a.at - b.at);
}

/** The last public message came from the customer. */
export function awaitingUs(ticket) {
  const publicList = publicMessages(ticket);
  const last = publicList[publicList.length - 1];
  return last ? last.authorId === ticket.customerId : ticket.status === "new";
}
