import test from "node:test";
import assert from "node:assert/strict";

import {
  transition, canTransition, transitionsFrom, addMessage, eventForStatus,
  priorityScore, sortQueue, filterTickets, groupByStatus, queueSummary, SAVED_VIEWS,
} from "../src/tickets.js";
import { createCalendar } from "../src/sla.js";

const NOW = Date.UTC(2026, 9, 28, 12, 0);
const CALENDAR = createCalendar({
  offsetMinutes: 0,
  hours: { 1: [[540, 1080]], 2: [[540, 1080]], 3: [[540, 1080]], 4: [[540, 1080]], 5: [[540, 1080]], 6: [], 7: [] },
});

function ticket(overrides = {}) {
  return {
    id: "t1",
    number: "DSK-1",
    subject: "Something is broken",
    customerId: "cu-1",
    assigneeId: "ag-1",
    priority: "normal",
    status: "open",
    createdAt: NOW - 10 * 60_000,
    updatedAt: NOW - 10 * 60_000,
    tags: [],
    history: [{ status: "new", at: NOW - 10 * 60_000 }, { status: "open", at: NOW - 9 * 60_000 }],
    messages: [],
    ...overrides,
  };
}

function withMessages(overrides = {}) {
  return ticket({
    messages: [
      { id: "m1", kind: "customer", authorId: "cu-1", at: NOW - 8 * 60_000, body: "It is broken" },
      { id: "m2", kind: "reply", authorId: "ag-1", at: NOW - 5 * 60_000, body: "Looking now" },
    ],
    ...overrides,
  });
}

test("valid transitions return a new ticket and keep the old one intact", () => {
  const before = ticket();
  const after = transition(before, "reply", { at: NOW, actorId: "ag-1" });
  assert.equal(before.status, "open", "input was not mutated");
  assert.equal(after.status, "pending_customer");
  assert.equal(after.history.length, 3);
  assert.deepEqual(after.history.at(-1), { status: "pending_customer", event: "reply", at: NOW, actorId: "ag-1", note: null });
  assert.equal(canTransition("open", "reply"), true);
  assert.equal(canTransition("closed", "reply"), false);
});

test("the state machine refuses moves that make no sense", () => {
  assert.throws(() => transition(ticket(), "reopen"), /cannot apply/);
  assert.throws(() => transition(ticket({ status: "closed" }), "reply"), /cannot apply/);
  assert.throws(() => transition(ticket({ status: "resolved" }), "assign"), /cannot apply/);
  assert.throws(() => transition(ticket({ status: "new" }), "customer_reply"), /cannot apply/);
});

test("the main lifecycle transitions work", () => {
  const assigned = transition(ticket({ status: "new", assigneeId: null }), "assign", { at: NOW });
  assert.equal(assigned.status, "open");
  assert.equal(transition(ticket(), "escalate", { at: NOW }).status, "pending_engineering");
  assert.equal(transition(ticket({ status: "pending_customer" }), "customer_reply", { at: NOW }).status, "open");
  assert.equal(transition(ticket({ status: "resolved" }), "reopen", { at: NOW }).status, "open");
  assert.equal(transition(ticket({ status: "resolved" }), "close", { at: NOW }).status, "closed");
  assert.equal(transitionsFrom("open").map((row) => row.event).sort().join(","), "close,customer_reply,escalate,reply,resolve");
});

test("history is sorted even when events arrive out of order", () => {
  const outOfOrder = ticket({
    history: [
      { status: "new", at: NOW - 30 * 60_000 },
      { status: "open", at: NOW - 20 * 60_000 },
    ],
  });
  const moved = transition(outOfOrder, "resolve", { at: NOW - 25 * 60_000 });
  assert.deepEqual(moved.history.map((row) => row.at), [
    NOW - 30 * 60_000, NOW - 25 * 60_000, NOW - 20 * 60_000,
  ]);
  assert.equal(moved.status, "resolved");
});

test("eventForStatus maps kanban columns to transitions", () => {
  assert.equal(eventForStatus("resolved"), "resolve");
  assert.equal(eventForStatus("closed"), "close");
  assert.equal(eventForStatus("pending_engineering"), "escalate");
  assert.equal(eventForStatus("open"), "reopen");
  assert.equal(eventForStatus("pending_customer"), null);
});

test("addMessage validates kinds and sorts by time", () => {
  const withNote = addMessage(ticket(), { kind: "note", authorId: "ag-1", at: NOW, body: "internal" });
  assert.equal(withNote.messages.length, 1);
  assert.equal(withNote.updatedAt, NOW);
  const reordered = addMessage(
    { ...ticket(), messages: [{ id: "late", kind: "customer", authorId: "cu-1", at: NOW, body: "late" }] },
    { kind: "reply", authorId: "ag-1", at: NOW - 60_000, body: "earlier" },
  );
  assert.deepEqual(reordered.messages.map((message) => message.id), ["msg-t1-2", "late"]);
  assert.throws(() => addMessage(ticket(), { kind: "tweet", authorId: "ag-1", at: NOW, body: "no" }), TypeError);
});

test("priorityScore returns a stable, explainable ordering", () => {
  const urgent = ticket({ id: "a", priority: "urgent" });
  const low = ticket({ id: "b", priority: "low" });
  const old = ticket({ id: "c", priority: "normal", createdAt: NOW - 8 * 60 * 60_000, history: [{ status: "new", at: NOW - 8 * 60 * 60_000 }] });
  const breached = ticket({ id: "d", priority: "normal", createdAt: NOW - 48 * 60 * 60_000, history: [{ status: "new", at: NOW - 48 * 60 * 60_000 }] });

  assert.ok(priorityScore(urgent, { now: NOW, calendar: CALENDAR }) > priorityScore(low, { now: NOW, calendar: CALENDAR }));
  assert.ok(priorityScore(old, { now: NOW, calendar: CALENDAR }) > priorityScore(ticket(), { now: NOW, calendar: CALENDAR }), "waiting longer ranks higher");
  const breachedScore = priorityScore(breached, { now: NOW, calendar: CALENDAR });
  const okScore = priorityScore(breached, { now: NOW, calendar: CALENDAR, sla: { state: "ok" } });
  assert.equal(breachedScore - okScore, 200, "a breach adds the documented weight");
  const vip = priorityScore(ticket(), { now: NOW, calendar: CALENDAR, customer: { tier: "VIP" } });
  const standard = priorityScore(ticket(), { now: NOW, calendar: CALENDAR, customer: { tier: "Standard" } });
  assert.equal(vip - standard, 40);
});

test("sortQueue puts the most urgent ticket first", () => {
  const tickets = [
    ticket({ id: "low", priority: "low" }),
    ticket({ id: "urgent", priority: "urgent", createdAt: NOW - 60 * 60_000, history: [{ status: "new", at: NOW - 60 * 60_000 }] }),
    ticket({ id: "normal", priority: "normal" }),
  ];
  assert.equal(sortQueue(tickets, { now: NOW, calendar: CALENDAR })[0].id, "urgent");
});

test("saved views filter by status, owner, priority and SLA state", () => {
  const tickets = [
    ticket({ id: "open", status: "open", assigneeId: "ag-1" }),
    ticket({ id: "unowned", status: "new", assigneeId: null, priority: "urgent" }),
    ticket({ id: "paused", status: "pending_customer", assigneeId: "ag-2", history: [{ status: "new", at: NOW - 600_000 }, { status: "pending_customer", at: NOW - 300_000 }] }),
    ticket({ id: "done", status: "resolved", history: [{ status: "new", at: NOW - 600_000 }, { status: "resolved", at: NOW - 300_000 }] }),
    ticket({ id: "old", status: "open", assigneeId: "ag-2", createdAt: NOW - 48 * 60 * 60_000, history: [{ status: "new", at: NOW - 48 * 60 * 60_000 }] }),
  ];
  const ids = (view, extra = {}) => filterTickets(tickets, { view, ...extra }, { now: NOW, calendar: CALENDAR }).map((row) => row.id).sort();

  assert.deepEqual(ids("inbox"), ["old", "open", "paused", "unowned"]);
  assert.deepEqual(ids("mine", { agentId: "ag-1" }), ["open"]);
  assert.deepEqual(ids("unassigned"), ["unowned"]);
  assert.deepEqual(ids("urgent"), ["unowned"]);
  assert.deepEqual(ids("paused"), ["paused"]);
  assert.deepEqual(ids("resolved"), ["done"]);
  assert.deepEqual(ids("all"), ["done", "old", "open", "paused", "unowned"]);
  assert.deepEqual(ids("breached"), ["old"]);
  assert.equal(SAVED_VIEWS.length, 8);
});

test("free-text search matches subject, number and tags", () => {
  const tickets = [
    ticket({ id: "a", subject: "CSV export drops rows", tags: ["export"] }),
    ticket({ id: "b", number: "DSK-99", subject: "Billing question", tags: ["billing"] }),
  ];
  const search = (query) => filterTickets(tickets, { view: "all", query }, { now: NOW, calendar: CALENDAR }).map((row) => row.id);
  assert.deepEqual(search("csv"), ["a"]);
  assert.deepEqual(search("DSK-99"), ["b"]);
  assert.deepEqual(search("billing"), ["b"]);
  assert.deepEqual(search("nothing"), []);
});

test("kanban columns are in workflow order and sort by priority", () => {
  const columns = groupByStatus([
    ticket({ id: "low", status: "new", priority: "low" }),
    ticket({ id: "urgent", status: "new", priority: "urgent" }),
    ticket({ id: "resolved", status: "resolved" }),
  ]);
  assert.deepEqual(columns.map((column) => column.status), ["new", "open", "pending_customer", "pending_engineering", "resolved", "closed"]);
  assert.deepEqual(columns[0].tickets.map((row) => row.id), ["urgent", "low"]);
  assert.equal(columns[1].tickets.length, 0);
});

test("queueSummary counts the inbox and returns the policy table", () => {
  const summary = queueSummary([
    ticket({ id: "open" }),
    ticket({ id: "new", status: "new", assigneeId: null }),
    ticket({ id: "paused", status: "pending_customer", history: [{ status: "new", at: NOW - 900_000 }, { status: "pending_customer", at: NOW - 300_000 }] }),
    ticket({ id: "done", status: "closed" }),
  ], { now: NOW, calendar: CALENDAR });
  assert.equal(summary.open, 3);
  assert.equal(summary.unassigned, 1);
  assert.equal(summary.paused, 1);
  assert.equal(summary.policies.length, 4);
  assert.equal(summary.policies[0].priority, "urgent");
});
