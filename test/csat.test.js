import test from "node:test";
import assert from "node:assert/strict";

import { csatSummary, agentCsat, csatTrend, csatComments, eligibleTickets, CSAT_SCALE } from "../src/csat.js";
import { buildSampleData } from "../src/sample.js";

const HOUR = 3_600_000;
const NOW = Date.UTC(2026, 9, 28, 12, 0);

function rated(status, score, comment = null, at = NOW - 48 * HOUR) {
  return { id: `t-${status}-${score}-${at}`, status, assigneeId: "ag-1", csat: { score, comment, at } };
}

test("an empty survey reports no average rather than zero", () => {
  const summary = csatSummary([]);
  assert.equal(summary.eligible, 0);
  assert.equal(summary.responses, 0);
  assert.equal(summary.rate, 0);
  assert.equal(summary.average, null, "no responses is not zero stars");
  assert.equal(summary.satisfiedRate, null);
});

test("only resolved and closed tickets are eligible", () => {
  const tickets = [
    rated("resolved", 5),
    rated("closed", 4),
    { status: "open", csat: { score: 1, at: NOW } },
    { status: "pending_customer" },
  ];
  assert.equal(eligibleTickets(tickets).length, 2);
});

test("response rate and average keep their denominator visible", () => {
  const tickets = [
    rated("resolved", 5), rated("resolved", 4), rated("closed", 3),
    rated("closed", 5), rated("closed", 1),
    { id: "silent-1", status: "resolved" },
    { id: "silent-2", status: "closed" },
  ];
  const summary = csatSummary(tickets);
  assert.equal(summary.eligible, 7);
  assert.equal(summary.responses, 5);
  assert.equal(summary.rate, 5 / 7);
  assert.equal(summary.average, 18 / 5);
  assert.equal(summary.satisfiedRate, 3 / 5);
  assert.equal(summary.score, 60);
});

test("the distribution covers every point of the scale", () => {
  const tickets = [rated("resolved", 5), rated("resolved", 5), rated("closed", 3), rated("closed", 1)];
  const distribution = csatSummary(tickets).distribution;
  assert.deepEqual(distribution.map((row) => row.score), CSAT_SCALE);
  assert.deepEqual(distribution.map((row) => row.count), [1, 0, 1, 0, 2]);
  assert.equal(csatSummary(tickets).promoters, 2);
  assert.equal(csatSummary(tickets).detractors, 2);
});

test("per-agent CSAT sorts by average and includes agents with no responses", () => {
  const agents = [
    { id: "ag-1", name: "Asha", initials: "AK" },
    { id: "ag-2", name: "Bibek", initials: "BS" },
    { id: "ag-3", name: "Nisha", initials: "NT" },
  ];
  const tickets = [
    { ...rated("resolved", 5), assigneeId: "ag-2" },
    { ...rated("resolved", 4), assigneeId: "ag-2" },
    { ...rated("resolved", 2), assigneeId: "ag-1" },
  ];
  const rows = agentCsat(tickets, agents);
  assert.deepEqual(rows.map((row) => row.name), ["Bibek", "Asha", "Nisha"]);
  assert.equal(rows[0].average, 4.5);
  assert.equal(rows[0].responses, 2);
  assert.equal(rows[2].average, null);
});

test("the trend groups responses into relative weeks and leaves empty weeks null", () => {
  const tickets = [
    { status: "resolved", csat: { score: 5, at: NOW - 1 * HOUR } },
    { status: "closed", csat: { score: 3, at: NOW - 9 * 24 * HOUR } },
    { status: "resolved", csat: { score: 4, at: NOW - 60 * 24 * HOUR } },
  ];
  const rows = csatTrend(tickets, { weeks: 6, now: NOW });
  assert.equal(rows.length, 6);
  assert.equal(rows.at(-1).responses, 1);
  assert.equal(rows.at(-1).average, 5);
  assert.equal(rows.at(-2).responses, 1);
  assert.equal(rows.at(-2).average, 3);
  assert.equal(rows[0].average, null, "a week with no replies is null, not zero");
  assert.deepEqual(rows.map((row) => row.label), ["W-5", "W-4", "W-3", "W-2", "W-1", "W-0"]);
});

test("comments surface the low scores first", () => {
  const tickets = [
    rated("resolved", 5, "Excellent", NOW - 1 * HOUR),
    rated("resolved", 2, "Slow refund", NOW - 2 * HOUR),
    rated("closed", 1, "Never answered", NOW - 3 * HOUR),
    rated("closed", 4, null),
  ];
  const comments = csatComments(tickets, { limit: 2 });
  assert.deepEqual(comments.map((row) => row.score), [1, 2]);
  assert.equal(comments[0].comment, "Never answered");
});

test("the seeded workspace is internally consistent", () => {
  const data = buildSampleData({ now: NOW });
  assert.equal(data.tickets.length, 17);
  assert.equal(new Set(data.tickets.map((ticket) => ticket.number)).size, 17, "numbers are unique");
  for (const ticket of data.tickets) {
    const last = ticket.history[ticket.history.length - 1];
    assert.equal(last.status, ticket.status, `${ticket.number} history ends in its status`);
    assert.ok(ticket.messages.some((message) => message.kind === "customer"), `${ticket.number} has a customer message`);
    if (ticket.csat) {
      assert.ok(ticket.status === "resolved" || ticket.status === "closed", "only closed tickets carry CSAT");
      assert.ok(ticket.csat.score >= 1 && ticket.csat.score <= 5);
    }
  }
  const summary = csatSummary(data.tickets);
  assert.equal(summary.eligible, 7);
  assert.equal(summary.responses, 6);
  assert.equal(summary.average, 3.8333333333333335);
  assert.equal(summary.satisfiedRate, 4 / 6);
});
