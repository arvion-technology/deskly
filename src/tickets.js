/**
 * Ticket state machine, queue ranking and saved views.
 *
 * The state machine is a table, not a pile of `if`s. That matters because the
 * same transitions are triggered from three places, the reply box, the status
 * menu and the kanban board, and each of them must be refused in exactly the
 * same cases. Illegal transitions throw; the UI catches and shows why.
 */

import {
  PRIORITY_ORDER, PRIORITIES, STATE_ORDER, STATES, firstAgentReply, getPolicy, isOpen,
  priorityRank,
} from "./model.js";
import { activeBusinessMinutes, evaluateSla } from "./sla.js";

/**
 * state → { event: nextState }. `reply` means a public agent reply, which hands
 * the ticket back to the customer and starts the pause. Internal notes change
 * no state and are not in this table.
 */
export const TRANSITIONS = Object.freeze({
  new: {
    assign: "open",
    reply: "open",
    resolve: "resolved",
    close: "closed",
  },
  open: {
    reply: "pending_customer",
    customer_reply: "open",
    escalate: "pending_engineering",
    resolve: "resolved",
    close: "closed",
  },
  pending_customer: {
    customer_reply: "open",
    reply: "pending_customer",
    resolve: "resolved",
    close: "closed",
  },
  pending_engineering: {
    customer_reply: "open",
    reply: "pending_engineering",
    resolve: "resolved",
    close: "closed",
  },
  resolved: {
    reopen: "open",
    customer_reply: "open",
    close: "closed",
  },
  closed: {
    reopen: "open",
  },
});

export const EVENTS = Object.freeze({
  assign: "Assign",
  reply: "Reply to customer",
  customer_reply: "Customer replied",
  escalate: "Escalate to engineering",
  resolve: "Resolve",
  close: "Close",
  reopen: "Reopen",
});

export function canTransition(status, event) {
  return Boolean(TRANSITIONS[status]?.[event]) && STATES[status] !== undefined;
}

export function transitionsFrom(status) {
  return Object.entries(TRANSITIONS[status] || {}).map(([event, next]) => ({ event, next, label: EVENTS[event] }));
}

/** Apply an event, returning a new ticket. The input is never mutated. */
export function transition(ticket, event, { at = Date.now(), actorId = null, note = null } = {}) {
  if (!Number.isFinite(at)) throw new TypeError("at must be a timestamp");
  const next = TRANSITIONS[ticket.status]?.[event];
  if (!next) {
    throw new Error(`cannot apply "${event}" to a ${STATES[ticket.status]?.label || ticket.status} ticket`);
  }
  const entry = { status: next, event, at, actorId, note };
  const history = [...(ticket.history || []), entry].sort((a, b) => a.at - b.at);
  return {
    ...ticket,
    status: next,
    updatedAt: Math.max(ticket.updatedAt || 0, at),
    history,
  };
}

/** Kanban drop helper: which event moves a ticket into a target column? */
export function eventForStatus(targetStatus) {
  switch (targetStatus) {
    case "open": return "reopen";
    case "pending_engineering": return "escalate";
    case "resolved": return "resolve";
    case "closed": return "close";
    default: return null;
  }
}

export function addMessage(ticket, message) {
  const entry = {
    id: message.id || `msg-${ticket.id}-${(ticket.messages || []).length + 1}`,
    kind: message.kind || "reply",
    authorId: message.authorId,
    at: message.at,
    body: message.body,
  };
  if (!["customer", "reply", "note"].includes(entry.kind)) throw new TypeError(`unknown message kind: ${entry.kind}`);
  return {
    ...ticket,
    messages: [...(ticket.messages || []), entry].sort((a, b) => a.at - b.at),
    updatedAt: Math.max(ticket.updatedAt || 0, entry.at),
  };
}

/* ------------------------------------------------------------------ queue */

/**
 * Queue score: priority dominates, then how long the ticket has waited in
 * business time, then SLA pressure, then whether the customer is a VIP. It is
 * deliberately not a black box, every weight is a named constant.
 */
export const QUEUE_WEIGHTS = Object.freeze({
  priority: 100,
  waitingCapMinutes: 480,
  breached: 200,
  warning: 60,
  awaitingUs: 30,
  vip: 40,
});

export function priorityScore(ticket, { now = Date.now(), calendar, customer = null, sla = null } = {}) {
  const age = activeBusinessMinutes(ticket, now, calendar);
  const slaState = sla?.state || evaluateSla(ticket, { now, ...(calendar ? { calendar } : {}) }).state;
  const awaiting = ticket.status === "open" || ticket.status === "new";
  return Math.round(
    priorityRank(ticket.priority) * QUEUE_WEIGHTS.priority
    + Math.min(QUEUE_WEIGHTS.waitingCapMinutes, age)
    + (slaState === "breached" ? QUEUE_WEIGHTS.breached : slaState === "warning" ? QUEUE_WEIGHTS.warning : 0)
    + (awaiting ? QUEUE_WEIGHTS.awaitingUs : 0)
    + (customer?.tier === "VIP" ? QUEUE_WEIGHTS.vip : 0),
  );
}

/** Sort a queue with the most urgent ticket first. */
export function sortQueue(tickets, options = {}) {
  const { now = Date.now(), calendar, customers = [] } = options;
  return tickets
    .map((ticket) => {
      const customer = customers.find((row) => row.id === ticket.customerId) || null;
      const sla = evaluateSla(ticket, { now, ...(calendar ? { calendar } : {}) });
      return { ticket, sla, score: priorityScore(ticket, { now, calendar, customer, sla }) };
    })
    .sort((a, b) => b.score - a.score || a.ticket.createdAt - b.ticket.createdAt)
    .map((row) => row.ticket);
}

/** Every ticket passes through here so counts and priority ranking never disagree. */
export function annotateQueue(tickets, { now = Date.now(), calendar, customers = [] } = {}) {
  const byId = new Map(tickets.map((ticket) => [ticket.id, ticket]));
  const ranked = sortQueue(tickets, { now, calendar, customers });
  const rank = new Map(ranked.map((ticket, index) => [ticket.id, index + 1]));
  return tickets.map((ticket) => {
    const customer = customers.find((row) => row.id === ticket.customerId) || null;
    return {
      ...byId.get(ticket.id),
      sla: evaluateSla(ticket, { now, ...(calendar ? { calendar } : {}) }),
      queueRank: rank.get(ticket.id),
      customer,
    };
  });
}

export const SAVED_VIEWS = Object.freeze([
  { id: "inbox", label: "Inbox", description: "Everything not resolved" },
  { id: "mine", label: "Assigned to me", description: "My open queue" },
  { id: "unassigned", label: "Unassigned", description: "Needs an owner" },
  { id: "urgent", label: "Urgent", description: "Priority urgent" },
  { id: "breached", label: "Breached", description: "SLA already missed" },
  { id: "paused", label: "Waiting on customer", description: "Clock paused" },
  { id: "resolved", label: "Resolved", description: "Recently resolved" },
  { id: "all", label: "All tickets", description: "Including closed" },
]);

export function filterTickets(tickets, { view = "inbox", query = "", agentId = null, status = null, priority = null } = {}, { now = Date.now(), calendar } = {}) {
  const needle = String(query || "").trim().toLowerCase();
  return tickets.filter((ticket) => {
    const sla = evaluateSla(ticket, { now, ...(calendar ? { calendar } : {}) });
    if (view === "inbox" && !isOpen(ticket.status)) return false;
    if (view === "mine" && (!isOpen(ticket.status) || ticket.assigneeId !== agentId)) return false;
    if (view === "unassigned" && (!isOpen(ticket.status) || ticket.assigneeId)) return false;
    if (view === "urgent" && (!isOpen(ticket.status) || ticket.priority !== "urgent")) return false;
    if (view === "breached" && sla.state !== "breached") return false;
    if (view === "paused" && ticket.status !== "pending_customer") return false;
    if (view === "resolved" && !["resolved", "closed"].includes(ticket.status)) return false;
    if (status && ticket.status !== status) return false;
    if (priority && ticket.priority !== priority) return false;
    if (!needle) return true;
    return ticket.subject.toLowerCase().includes(needle)
      || ticket.number.toLowerCase().includes(needle)
      || (ticket.tags || []).some((tag) => tag.toLowerCase().includes(needle));
  });
}

/** Counts for the rail, computed from the same filter rules as the list. */
export function viewCounts(tickets, { now = Date.now(), calendar, agentId = null } = {}) {
  const counts = {};
  for (const view of SAVED_VIEWS) {
    counts[view.id] = filterTickets(tickets, { view: view.id, agentId }, { now, calendar }).length;
  }
  return counts;
}

/** Kanban columns in workflow order, empty columns included. */
export function groupByStatus(tickets) {
  const rank = { urgent: 4, high: 3, normal: 2, low: 1 };
  return STATE_ORDER.map((status) => ({
    status,
    label: STATES[status].label,
    tone: STATES[status].tone,
    tickets: tickets
      .filter((ticket) => ticket.status === status)
      .sort((a, b) => (rank[b.priority] || 0) - (rank[a.priority] || 0) || a.createdAt - b.createdAt),
  }));
}

/** Headline numbers for the inbox rail. */
export function queueSummary(tickets, { now = Date.now(), calendar } = {}) {
  const annotated = tickets.map((ticket) => ({
    ticket,
    sla: evaluateSla(ticket, { now, ...(calendar ? { calendar } : {}) }),
  }));
  const open = annotated.filter((row) => isOpen(row.ticket.status));
  const replied = tickets.filter((ticket) => firstAgentReply(ticket) !== null);
  const responseMinutes = replied.map((ticket) => {
    const replyAt = firstAgentReply(ticket);
    return activeBusinessMinutes(ticket, replyAt, calendar);
  });
  return {
    open: open.length,
    unassigned: open.filter((row) => !row.ticket.assigneeId).length,
    breached: annotated.filter((row) => row.sla.state === "breached").length,
    warning: annotated.filter((row) => row.sla.state === "warning").length,
    paused: open.filter((row) => row.ticket.status === "pending_customer").length,
    awaitingUs: open.filter((row) => row.ticket.assigneeId && (row.ticket.status === "open" || row.ticket.status === "new")).length,
    medianFirstResponseMinutes: responseMinutes.length
      ? responseMinutes.sort((a, b) => a - b)[Math.floor(responseMinutes.length / 2)]
      : null,
    policies: PRIORITY_ORDER.map((priority) => ({ priority, label: PRIORITIES[priority].label, ...getPolicy(priority) })),
  };
}
