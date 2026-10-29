// Deskly, demo application.
// Every SLA number, state transition and CSAT figure is computed by ../src/*.js.
// This file builds the three-pane inbox, the kanban board and the reports.
import { PRIORITIES, STATES } from "../src/model.js";
import { evaluateSla, countdownLabel, formatMinutes } from "../src/sla.js";
import {
  transition, canTransition, addMessage, filterTickets, annotateQueue,
  viewCounts, groupByStatus, queueSummary, SAVED_VIEWS,
} from "../src/tickets.js";
import { csatSummary, agentCsat, csatTrend, csatComments } from "../src/csat.js";
import { buildSampleData } from "../src/sample.js";

const $ = A.$, $$ = A.$$, el = A.el;
const STORE_KEY = "deskly:v1";

/* ------------------------------------------------------------------ state */

function loadData() {
  const saved = A.store.get(STORE_KEY);
  if (saved && Array.isArray(saved.tickets) && saved.tickets.length && saved.calendar) return saved;
  return buildSampleData({ now: Date.now() });
}

let DB = loadData();
const state = {
  view: "inbox",
  filter: "inbox",
  query: "",
  sort: "queue",
  ticketId: null,
  reply: "",
  listIds: [],
};

const now = () => Date.now();
const calendar = () => DB.calendar;

function persist() {
  if (!A.store.set(STORE_KEY, DB)) A.toast("Could not save to browser storage", "error");
}

function customerById(id) {
  return DB.customers.find((customer) => customer.id === id)
    || { name: "Unknown", company: ", ", plan: ", ", email: "", tier: "Standard" };
}

function agentById(id) {
  return DB.agents.find((agent) => agent.id === id) || null;
}

function ticketById(id) {
  return DB.tickets.find((ticket) => ticket.id === id) || null;
}

function currentTicket() {
  return ticketById(state.ticketId) || DB.tickets[0] || null;
}

function replaceTicket(updated) {
  const index = DB.tickets.findIndex((ticket) => ticket.id === updated.id);
  if (index >= 0) DB.tickets[index] = updated;
  else DB.tickets.push(updated);
}

function slaOf(ticket) {
  return evaluateSla(ticket, { now: now(), calendar: calendar() });
}

function initials(name) {
  return (name || "?").split(/\s+/).filter(Boolean).slice(0, 2).map((part) => part[0].toUpperCase()).join("");
}

function avatarFor(name, tone = "") {
  return el("span", { class: `avatar sm ${tone}`, text: initials(name) });
}

const STATUS_TONE = { new: "blue", open: "gold", pending_customer: "purple", pending_engineering: "blue", resolved: "green", closed: "" };

function statusBadge(status) {
  return el("span", { class: `badge ${STATUS_TONE[status] || ""}`, text: STATES[status]?.label || status });
}

function priorityBadge(priority) {
  const info = PRIORITIES[priority] || PRIORITIES.normal;
  return el("span", { class: `badge ${info.tone}`, text: info.label });
}

/* --------------------------------------------------------- SLA presentation */

function badgeFor(sla) {
  const candidates = [sla.first, sla.resolution].filter((target) => !target.met);
  const target = candidates.length
    ? candidates.sort((a, b) => a.remaining - b.remaining)[0]
    : (sla.first.breached ? sla.first : sla.resolution);
  let tone = sla.state;
  if (sla.state === "met") tone = "met";
  else if (target.met) tone = "breached";
  return { text: countdownLabel(target), tone };
}

function targetTone(target, slaState) {
  if (target.paused) return "paused";
  if (target.breached) return "breached";
  if (target.met) return "met";
  if (slaState === "warning") return "warning";
  return "";
}

function slaCard(label, target, slaState) {
  return el("div", { class: `sla-card ${targetTone(target, slaState)}` },
    el("div", { class: "sla-label", text: label }),
    el("div", { class: "sla-value" },
      el("b", { text: countdownLabel(target) }),
      el("span", { text: `target ${formatMinutes(target.target)}` })),
    el("div", { class: "progress" }, el("i", { style: `width:${Math.round(Math.min(1, target.progress) * 100)}%` })),
    el("div", { class: "small muted", style: "margin-top:6px;font-size:10.5px", text: target.met
      ? `met in ${formatMinutes(target.elapsed)}${target.breached ? ", late" : ""}`
      : `${formatMinutes(target.elapsed)} used` }));
}

/* ------------------------------------------------------------------- rail */

function renderRail() {
  const counts = viewCounts(DB.tickets, { now: now(), calendar: calendar(), agentId: DB.currentAgentId });
  $("#rail-views").replaceChildren(...SAVED_VIEWS.map((view) =>
    el("button", {
      class: `rail-item ${state.filter === view.id ? "active" : ""}`,
      "data-filter": view.id,
      title: view.description,
      onclick: () => setFilter(view.id),
    },
    el("span", { class: "mark" }),
    el("span", { text: view.label }),
    el("span", { class: "count", text: String(counts[view.id] || 0) }))));

  $("#rail-agents").replaceChildren(...DB.agents.map((agent) =>
    el("div", { class: "rail-agent" },
      avatarFor(agent.name, "purple"),
      el("span", { text: agent.name }),
      el("span", { class: `presence ${agent.online ? "online" : ""}` }))));

  const summary = queueSummary(DB.tickets, { now: now(), calendar: calendar() });
  $("#rail-summary").replaceChildren(
    ...[
      ["Open", summary.open],
      ["Breached", summary.breached],
      ["At risk", summary.warning],
      ["Paused", summary.paused],
      ["Median first reply", summary.medianFirstResponseMinutes === null ? ", " : formatMinutes(summary.medianFirstResponseMinutes)],
    ].map(([label, value]) => el("div", { class: "rail-summary-row" },
      el("span", { text: label }),
      el("span", { class: "spacer" }),
      el("b", { text: String(value) }))));

  $("#sidebar-stats").replaceChildren(
    el("span", { text: `${summary.open} open tickets · ${DB.customers.length} customers` }),
    el("br"),
    el("span", { style: summary.breached ? "color:var(--red)" : "", text: `${summary.breached} breached SLA${summary.breached === 1 ? "" : "s"}` }),
  );
  $("#nav-inbox-count").textContent = String(counts.inbox || 0);
  $("#topbar-meta").textContent = `${DB.tickets.length} tickets · ${DB.agents.length} agents`;
  $("#topbar-sla-text").textContent = `${summary.breached} breached`;
  $("#topbar-sla").className = summary.breached ? "badge red" : "badge green";
}

function setFilter(view) {
  state.filter = view;
  state.query = "";
  $("#ticket-search").value = "";
  if (state.view !== "inbox") location.hash = "#inbox";
  renderInbox();
}

/* ------------------------------------------------------------- ticket list */

function orderedTickets() {
  const filtered = filterTickets(DB.tickets, {
    view: state.filter,
    query: state.query,
    agentId: DB.currentAgentId,
  }, { now: now(), calendar: calendar() });
  const annotated = annotateQueue(filtered, { now: now(), calendar: calendar(), customers: DB.customers });
  if (state.sort === "newest") return [...annotated].sort((a, b) => b.createdAt - a.createdAt);
  if (state.sort === "oldest") return [...annotated].sort((a, b) => a.createdAt - b.createdAt);
  return [...annotated].sort((a, b) => a.queueRank - b.queueRank);
}

function renderTicketList() {
  const tickets = orderedTickets();
  state.listIds = tickets.map((ticket) => ticket.id);
  const viewLabel = SAVED_VIEWS.find((view) => view.id === state.filter)?.label || "Inbox";
  $("#list-title").textContent = viewLabel;
  $("#list-count").textContent = String(tickets.length);

  if (!tickets.length) {
    $("#ticket-list").replaceChildren(el("div", { class: "empty", style: "margin:16px" },
      el("strong", { text: "Nothing here" }),
      el("span", { text: "This saved view is empty with the current search." })));
    return;
  }
  $("#ticket-list").replaceChildren(...tickets.map((ticket) => {
    const badge = badgeFor(ticket.sla);
    const customer = customerById(ticket.customerId);
    return el("button", {
      class: `ticket-card ${ticket.id === state.ticketId ? "active" : ""}`,
      "data-ticket": ticket.id,
      onclick: () => selectTicket(ticket.id),
    },
    el("div", { class: "tc-top" },
      avatarFor(customer.name),
      el("span", { class: "tc-company", text: customer.company }),
      el("span", { class: "spacer" }),
      el("span", { class: `sla-mini ${badge.tone}`, text: badge.text })),
    el("div", { class: "tc-subject", text: ticket.subject }),
    el("div", { class: "tc-foot" },
      el("span", { class: `priority-dot ${ticket.priority}` }),
      el("span", { text: PRIORITIES[ticket.priority]?.label || "Normal" }),
      el("span", { text: "·" }),
      el("span", { class: "mono", text: ticket.number }),
      el("span", { text: "·" }),
      el("span", { text: A.fmt.relative(ticket.createdAt) }),
      el("span", { class: "spacer" }),
      ...(ticket.tags || []).slice(0, 1).map((tag) => el("span", { class: "tc-tag", text: tag }))));
  }));
}

function selectTicket(id) {
  state.ticketId = id;
  state.reply = "";
  renderTicketList();
  renderConversation();
  const active = $(".ticket-card.active");
  if (active) active.scrollIntoView({ block: "nearest" });
}

/* ----------------------------------------------------------- conversation */

function messageView(message, ticket) {
  const customer = customerById(ticket.customerId);
  const agent = agentById(message.authorId);
  const isCustomer = message.kind === "customer";
  const isNote = message.kind === "note";
  const name = isCustomer ? customer.name : agent ? agent.name : "Agent";
  const tone = isCustomer ? "" : "blue";
  return el("div", { class: `message ${isCustomer ? "customer" : isNote ? "note" : "agent"}` },
    avatarFor(name, tone),
    el("div", { class: "msg-body" },
      el("div", { class: "msg-head" },
        el("span", { class: "msg-author", text: isNote ? `Internal note · ${name}` : name }),
        el("span", { class: "msg-time", text: A.fmt.relative(message.at) }),
        isNote ? el("span", { class: "badge gold", style: "padding:1px 6px;font-size:9.5px", text: "team only" }) : null),
      el("div", { class: "msg-text", text: message.body })));
}

function conversationActions(ticket) {
  const actions = [];
  const add = (event, label, kind = "") => actions.push(el("button", {
    class: `btn sm ${kind}`,
    onclick: () => applyEvent(ticket, event),
    text: label,
  }));
  if (canTransition(ticket.status, "resolve")) add("resolve", "Resolve", "primary");
  if (canTransition(ticket.status, "escalate")) add("escalate", "Escalate to engineering");
  if (canTransition(ticket.status, "customer_reply")) add("customer_reply", "Customer replied", "ghost");
  if (canTransition(ticket.status, "close")) add("close", "Close", "ghost");
  if (canTransition(ticket.status, "reopen")) add("reopen", "Reopen", "primary");
  return actions;
}

function applyEvent(ticket, event) {
  try {
    const updated = transition(ticket, event, { at: now(), actorId: DB.currentAgentId });
    replaceTicket(updated);
    persist();
    A.toast(`${ticket.number} → ${STATES[updated.status].label}`, "success", 2200);
    renderInbox();
  } catch (error) {
    A.toast(error.message, "error");
  }
}

function assignTicket(ticket, agentId) {
  let updated = { ...ticket, assigneeId: agentId || null, updatedAt: now() };
  if (agentId && ticket.status === "new") {
    updated = transition(updated, "assign", { at: now(), actorId: agentId });
  }
  replaceTicket(updated);
  persist();
  A.toast(agentId ? `Assigned to ${agentById(agentId)?.name}` : "Ticket unassigned", "success", 1800);
  renderInbox();
}

function renderSlaStrip(ticket, sla) {
  return el("div", { class: "sla-strip", id: "sla-strip" },
    slaCard("First response", sla.first, sla.state),
    slaCard("Resolution", sla.resolution, sla.state));
}

function renderComposer(ticket) {
  const locked = ticket.status === "resolved" || ticket.status === "closed";
  if (locked) {
    return el("div", { class: "composer" },
      el("div", { class: "locked" },
        `This ticket is ${STATES[ticket.status].label.toLowerCase()}. Reopen it to reply.`,
        canTransition(ticket.status, "reopen")
          ? el("div", { style: "margin-top:10px" },
            el("button", { class: "btn sm", onclick: () => applyEvent(ticket, "reopen"), text: "Reopen ticket" }))
          : null));
  }
  const textarea = el("textarea", {
    class: "textarea", id: "reply-body", placeholder: "Write a reply to the customer…",
    oninput: (event) => { state.reply = event.target.value; },
  });
  textarea.value = state.reply || "";
  return el("div", { class: "composer" },
    el("div", { class: "composer-head" },
      el("span", { class: "badge", text: "Reply" }),
      el("select", { class: "select", id: "canned-select", style: "width:240px" },
        el("option", { value: "", text: "Insert a canned reply…" }),
        ...DB.cannedReplies.map((reply) => el("option", { value: reply.id, text: reply.label }))),
      el("button", {
        class: "btn ghost sm",
        onclick: () => {
          const selected = $("#canned-select")?.value;
          const canned = DB.cannedReplies.find((reply) => reply.id === selected);
          if (!canned) return A.toast("Pick a canned reply first", "error");
          const body = $("#reply-body");
          if (body) { body.value = canned.body; state.reply = canned.body; body.focus(); }
        },
        text: "Insert",
      })),
    textarea,
    el("div", { class: "composer-foot" },
      el("span", { class: "hint", text: "A public reply pauses the SLA and moves the ticket to Pending customer." }),
      el("span", { class: "spacer" }),
      el("button", { class: "btn sm", onclick: () => sendMessage(ticket, "note"), text: "Add note" }),
      el("button", { class: "btn primary sm", onclick: () => sendMessage(ticket, "reply"), text: "Send reply" })));
}

function sendMessage(ticket, kind) {
  const body = (state.reply || "").trim();
  if (!body) return A.toast(kind === "note" ? "Write a note first" : "Write a reply first", "error");
  let updated = addMessage(ticket, {
    kind,
    authorId: DB.currentAgentId,
    at: now(),
    body,
  });
  if (kind === "reply") {
    try {
      updated = transition(updated, "reply", { at: now(), actorId: DB.currentAgentId });
    } catch (error) {
      A.toast(error.message, "error");
      return;
    }
  }
  replaceTicket(updated);
  persist();
  state.reply = "";
  A.toast(kind === "note" ? "Internal note added" : "Reply sent · customer now owns the next move", "success", 2600);
  renderInbox();
}

function renderConversation() {
  const ticket = currentTicket();
  const host = $("#conversation");
  if (!ticket) {
    host.replaceChildren(el("div", { class: "empty", style: "margin:24px" },
      el("strong", { text: "No ticket selected" }),
      el("span", { text: "Pick one from the list." })));
    return;
  }
  state.ticketId = ticket.id;
  const sla = slaOf(ticket);
  const customer = customerById(ticket.customerId);

  const assignSelect = el("select", {
    class: "select", style: "width:170px", "aria-label": "Assignee",
    onchange: (event) => assignTicket(ticket, event.target.value || null),
  },
  el("option", { value: "", selected: ticket.assigneeId ? null : "", text: "Unassigned" }),
  ...DB.agents.map((agent) => el("option", {
    value: agent.id, selected: agent.id === ticket.assigneeId ? "" : null, text: agent.name,
  })));

  const header = el("div", { class: "conv-head" },
    el("div", { class: "conv-title" },
      el("div", { style: "min-width:0" },
        el("h2", { text: ticket.subject }),
        el("div", { class: "conv-meta" },
          el("span", { class: "mono", text: ticket.number }),
          el("span", { text: "·" }),
          statusBadge(ticket.status),
          priorityBadge(ticket.priority),
          el("span", { text: "·" }),
          el("span", { text: `${ticket.channel} · opened ${A.fmt.relative(ticket.createdAt)}` }),
          el("span", { class: "spacer" }),
          assignSelect))),
    el("div", { class: "conv-actions" }, ...conversationActions(ticket)),
    el("div", { class: "conv-requester" },
      avatarFor(customer.name),
      el("div", {},
        el("div", { class: "name", text: customer.name }),
        el("div", { class: "company", text: `${customer.company} · ${customer.plan} plan · ${customer.email}` })),
      el("span", { class: "spacer" }),
      el("span", { class: `badge ${customer.tier === "VIP" ? "gold" : ""}`, text: customer.tier }),
      el("span", { class: "badge", text: `Pause: ${sla.pausedMinutes ? formatMinutes(sla.pausedMinutes) : "none"}` })));

  const messages = el("div", { class: "messages", id: "messages" },
    ...ticket.messages.map((message) => messageView(message, ticket)));

  host.replaceChildren(
    header,
    renderSlaStrip(ticket, sla),
    messages,
    renderComposer(ticket),
  );
  requestAnimationFrame(() => {
    const box = $("#messages");
    if (box) box.scrollTop = box.scrollHeight;
  });
}

function renderInbox() {
  renderRail();
  renderTicketList();
  renderConversation();
}

/* ---------------------------------------------------------------- kanban */

function renderKanban() {
  const annotated = annotateQueue(DB.tickets, { now: now(), calendar: calendar(), customers: DB.customers });
  const columns = groupByStatus(annotated);
  const colours = { new: "#3a7bff", open: "#f5c26b", pending_customer: "#a78bfa", pending_engineering: "#3a7bff", resolved: "#34d399", closed: "#8d98ab" };
  $("#board").replaceChildren(...columns.map((column) => el("div", { class: "column" },
    el("div", { class: "column-head" },
      el("span", { class: "mark", style: `background:${colours[column.status]}` }),
      el("span", { class: "title", text: column.label }),
      el("span", { class: "count", text: String(column.tickets.length) })),
    ...column.tickets.map((ticket) => {
      const badge = badgeFor(ticket.sla);
      const customer = customerById(ticket.customerId);
      const agent = agentById(ticket.assigneeId);
      return el("button", {
        class: "kcard",
        onclick: () => { location.hash = `#inbox/${ticket.id}`; },
      },
      el("div", { class: "k-subject", text: ticket.subject }),
      el("div", { class: "k-meta" },
        avatarFor(customer.name),
        el("span", { class: "k-company", text: customer.company }),
        el("span", { class: `sla-mini ${badge.tone}`, text: badge.text })),
      el("div", { class: "k-foot" },
        el("span", { class: `priority-dot ${ticket.priority}` }),
        el("span", { class: "k-number", text: ticket.number }),
        el("span", { class: "spacer" }),
        agent ? avatarFor(agent.name, "purple") : el("span", { class: "small muted", text: "unassigned" })));
    }),
    column.tickets.length ? null : el("div", { class: "small muted", style: "padding:12px 4px", text: "No tickets" }))));
}

/* ------------------------------------------------------------------ CSAT */

function renderCsat() {
  const summary = csatSummary(DB.tickets);
  const trend = csatTrend(DB.tickets, { weeks: 6, now: now() }).filter((row) => row.average !== null);
  const agents = agentCsat(DB.tickets, DB.agents);
  const comments = csatComments(DB.tickets, { limit: 4 });
  const satisfied = summary.distribution.filter((row) => row.score >= 4).reduce((sum, row) => sum + row.count, 0);
  const neutral = summary.distribution.find((row) => row.score === 3)?.count || 0;
  const unsatisfied = summary.distribution.filter((row) => row.score <= 2).reduce((sum, row) => sum + row.count, 0);

  $("#csat-window").textContent = `last 6 weeks · ${summary.responses} responses`;
  $("#csat-kpis").replaceChildren(
    ...[
      ["Average CSAT", summary.average === null ? ", " : summary.average.toFixed(2), "out of 5", "gold"],
      ["Responses", `${summary.responses} / ${summary.eligible}`, `${(summary.rate * 100).toFixed(0)}% response rate`, "blue"],
      ["Satisfied", summary.satisfiedRate === null ? ", " : `${(summary.satisfiedRate * 100).toFixed(0)}%`, "scores 4 and 5", "green"],
      ["Detractors", String(summary.detractors), "scores 1-3", "gold"],
    ].map(([label, value, sub, tone]) => el("div", { class: "card" },
      el("div", { class: "stat" },
        el("div", { class: "stat-label", text: label }),
        el("div", { class: `stat-value ${tone}`, style: "font-size:26px", text: value }),
        el("div", { class: "small muted", text: sub })))),
  );
  $("#csat-score").textContent = summary.score === null ? "no responses" : `${summary.score}% satisfied`;

  if (trend.length >= 2) {
    $("#csat-trend").replaceChildren(A.lineChart({
      series: [{ name: "CSAT", data: trend.map((row) => row.average) }],
      labels: trend.map((row) => row.label),
      width: 640,
      height: 210,
      yFormat: (value) => value.toFixed(1),
    }));
  } else {
    $("#csat-trend").replaceChildren(el("div", { class: "empty" }, "Not enough responses to draw a trend yet."));
  }

  const colours = { satisfied: "#34d399", neutral: "#f5c26b", unsatisfied: "#f87171" };
  $("#csat-donut").replaceChildren(A.donut({
    slices: [
      { label: "Satisfied", value: satisfied, color: colours.satisfied },
      { label: "Neutral", value: neutral, color: colours.neutral },
      { label: "Unsatisfied", value: unsatisfied, color: colours.unsatisfied },
    ],
    size: 148,
    thickness: 18,
    centerValue: summary.average === null ? ", " : summary.average.toFixed(1),
    centerLabel: "average",
  }));
  $("#csat-legend").replaceChildren(...[
    ["Satisfied (4-5)", satisfied, colours.satisfied],
    ["Neutral (3)", neutral, colours.neutral],
    ["Unsatisfied (1-2)", unsatisfied, colours.unsatisfied],
  ].map(([label, count, colour]) => el("div", { class: "row", style: "gap:8px" },
    el("i", { style: `width:8px;height:8px;border-radius:2px;background:${colour}` }),
    el("span", { text: label }),
    el("span", { class: "spacer" }),
    el("span", { class: "mono muted", text: String(count) }))));

  $("#csat-distribution").replaceChildren(A.barList({
    rows: summary.distribution.slice().reverse().map((row) => ({
      label: `${row.score}${row.score === 5 ? " · excellent" : row.score === 1 ? " · very poor" : ""}`,
      value: row.count,
    })),
    format: (value) => `${value} response${value === 1 ? "" : "s"}`,
  }));

  $("#agent-table").replaceChildren(A.dataTable({
    columns: [
      {
        label: "Agent",
        render: (row) => el("div", { class: "row", style: "gap:8px" },
          avatarFor(row.name, "purple"),
          el("span", { style: "color:var(--text);font-weight:600", text: row.name })),
      },
      { label: "Resolved", align: "right", render: (row) => String(row.resolved) },
      { label: "Responses", align: "right", render: (row) => String(row.responses) },
      { label: "Average", align: "right", render: (row) => (row.average === null ? ", " : row.average.toFixed(2)) },
      { label: "Satisfied", align: "right", render: (row) => (row.satisfiedRate === null ? ", " : `${(row.satisfiedRate * 100).toFixed(0)}%`) },
    ],
    rows: agents,
  }));

  $("#csat-comments").replaceChildren(...(comments.length
    ? comments.map((comment) => el("div", { class: "csat-comment" },
      el("div", { class: "cc-head" },
        el("span", {
          class: "cc-score",
          style: comment.score <= 2 ? "color:var(--red)" : comment.score >= 4 ? "color:var(--green)" : "color:var(--gold)",
          text: `${comment.score} / 5`,
        }),
        el("span", { class: "cc-subject", text: `${comment.number} · ${comment.subject}` }),
        el("span", { class: "spacer" }),
        el("span", { class: "small muted", text: A.fmt.relative(comment.at) })),
      el("div", { class: "cc-body", text: comment.comment }),
      el("button", { class: "btn ghost sm", style: "margin-top:8px", onclick: () => { location.hash = `#inbox/${comment.ticketId}`; }, text: "Open ticket" })))
    : [el("div", { class: "small muted", text: "No comments left yet." })]));
}

/* --------------------------------------------------------------- settings */

const DAY_NAMES = { 1: "Monday", 2: "Tuesday", 3: "Wednesday", 4: "Thursday", 5: "Friday", 6: "Saturday", 7: "Sunday" };
const minutesToClock = (minutes) => `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;

function renderSettings() {
  const summary = queueSummary(DB.tickets, { now: now(), calendar: calendar() });
  $("#policy-table").replaceChildren(A.dataTable({
    columns: [
      { label: "Priority", render: (row) => priorityBadge(row.priority) },
      { label: "First response", align: "right", render: (row) => formatMinutes(row.firstResponseMinutes) },
      { label: "Resolution", align: "right", render: (row) => formatMinutes(row.resolutionMinutes) },
      { label: "Pause", align: "right", render: () => el("span", { class: "badge green", text: "on customer" }) },
    ],
    rows: summary.policies,
  }));

  const offset = calendar().offsetMinutes;
  const sign = offset >= 0 ? "+" : "−";
  const abs = Math.abs(offset);
  $("#calendar-offset").textContent = `UTC${sign}${String(Math.floor(abs / 60)).padStart(2, "0")}:${String(abs % 60).padStart(2, "0")}`;
  $("#hours-table").replaceChildren(...Object.keys(DAY_NAMES).map((day) => {
    const windows = calendar().hours[day] || [];
    return el("div", { class: "calendar-row" },
      el("span", { class: "day", text: DAY_NAMES[day] }),
      el("span", { class: "hours", text: windows.length ? windows.map(([open, close]) => `${minutesToClock(open)}, ${minutesToClock(close)}`).join(", ") : "closed" }));
  }));
  $("#holiday-list").textContent = `Closed holidays: ${calendar().holidays.length
    ? calendar().holidays.join(", ")
    : "none configured"}. The SLA engine skips these dates entirely.`;
}

/* ------------------------------------------------------------------ chrome */

function renderChrome() {
  renderRail();
  const navMap = { inbox: "inbox", kanban: "kanban", csat: "csat", settings: "settings" };
  $$("[data-view]").forEach((link) => link.classList.toggle("active", link.dataset.view === navMap[state.view]));
}

/* ----------------------------------------------------------------- routing */

const VIEWS = ["inbox", "kanban", "csat", "settings"];

function route() {
  const raw = location.hash.replace(/^#/, "") || "inbox";
  const [name, id] = raw.split("/");
  state.view = VIEWS.includes(name) ? name : "inbox";
  if (state.view === "inbox" && id) {
    const ticket = ticketById(id);
    if (ticket) state.ticketId = ticket.id;
  }
  $$("[data-view-panel]").forEach((panel) => { panel.hidden = panel.dataset.viewPanel !== state.view; });
  $("#main").classList.toggle("flush", state.view === "inbox");
  renderChrome();

  if (state.view === "inbox") {
    if (!state.ticketId || !ticketById(state.ticketId)) {
      const first = orderedTickets()[0];
      state.ticketId = first ? first.id : DB.tickets[0]?.id || null;
    }
    renderInbox();
  } else if (state.view === "kanban") renderKanban();
  else if (state.view === "csat") renderCsat();
  else renderSettings();
  window.scrollTo({ top: 0 });
}

/* -------------------------------------------------------------------- wire */

function refreshClocks() {
  if (state.view !== "inbox") return;
  renderRail();
  renderTicketList();
  const ticket = currentTicket();
  if (!ticket) return;
  const strip = $("#sla-strip");
  if (strip) strip.replaceWith(renderSlaStrip(ticket, slaOf(ticket)));
  const pauseBadge = $$("#conversation .conv-requester .badge").at(-1);
  if (pauseBadge) {
    const paused = slaOf(ticket).pausedMinutes;
    pauseBadge.textContent = `Pause: ${paused ? formatMinutes(paused) : "none"}`;
  }
}

function wire() {
  $("#rail-views").addEventListener("click", (event) => {
    const item = event.target.closest("[data-filter]");
    if (item) setFilter(item.dataset.filter);
  });

  $("#ticket-search").addEventListener("input", (event) => {
    state.query = event.target.value;
    renderTicketList();
  });

  $("#sort-select").addEventListener("change", (event) => {
    state.sort = event.target.value;
    renderTicketList();
  });

  $("#ticket-list").addEventListener("click", (event) => {
    const card = event.target.closest("[data-ticket]");
    if (card) selectTicket(card.dataset.ticket);
  });

  $$("[data-quick]").forEach((link) => link.addEventListener("click", (event) => {
    event.preventDefault();
    setFilter(link.dataset.quick);
  }));

  $("#reset-demo").addEventListener("click", () => {
    A.modal({
      title: "Reset the sample workspace?",
      body: el("p", { class: "small", text: "Replies, notes and state changes in this browser will be replaced by a freshly generated queue." }),
      actions: [
        { label: "Cancel" },
        {
          label: "Reset",
          kind: "danger",
          onClick: () => {
            DB = buildSampleData({ now: Date.now() });
            persist();
            state.ticketId = null;
            state.query = "";
            state.filter = "inbox";
            A.toast("Sample queue restored", "success");
            location.hash = "#inbox";
            route();
          },
        },
      ],
    });
  });

  document.addEventListener("keydown", (event) => {
    const tag = (event.target.tagName || "").toLowerCase();
    if (["input", "textarea", "select"].includes(tag) || event.metaKey || event.ctrlKey || event.altKey) return;
    if (event.key === "/") {
      event.preventDefault();
      $("#ticket-search")?.focus();
      return;
    }
    if (state.view !== "inbox") return;
    if (event.key === "j" || event.key === "k") {
      const ids = state.listIds;
      if (!ids.length) return;
      const index = Math.max(0, ids.indexOf(state.ticketId));
      const next = event.key === "j" ? Math.min(ids.length - 1, index + 1) : Math.max(0, index - 1);
      selectTicket(ids[next]);
      event.preventDefault();
    }
    if (event.key === "r") {
      $("#reply-body")?.focus();
      event.preventDefault();
    }
  });

  window.addEventListener("hashchange", route);
  setInterval(refreshClocks, 30_000);
}

wire();
route();
