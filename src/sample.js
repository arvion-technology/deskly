/**
 * The sample helpdesk.
 *
 * Seventeen tickets for a fictional support team, with enough variety to
 * exercise every state and every SLA outcome: a breached urgent ticket, a
 * paused reply, an unassigned new ticket, a pending-engineering escalation,
 * resolved tickets with CSAT, and one closed silently. Ticket timestamps are
 * relative to "now" so the inbox always has live countdowns.
 */

import { createCalendar } from "./sla.js";

const MINUTE = 60_000;

export const AGENTS = Object.freeze([
  { id: "ag-1", name: "Asha Karki", initials: "AK", role: "Support lead", online: true },
  { id: "ag-2", name: "Bibek Shrestha", initials: "BS", role: "Support engineer", online: true },
  { id: "ag-3", name: "Nisha Tamang", initials: "NT", role: "Support engineer", online: false },
  { id: "ag-4", name: "Rohan Gurung", initials: "RG", role: "Billing specialist", online: true },
]);

export const CUSTOMERS = Object.freeze([
  { id: "cu-1", name: "Dana Whitfield", company: "Kestrel Health", email: "dana@kestrelhealth.example", plan: "Scale", tier: "VIP", timezone: "America/New_York" },
  { id: "cu-2", name: "Anish Shrestha", company: "Sundara Coffee", email: "anish@sundara.example", plan: "Growth", tier: "Standard", timezone: "Asia/Kathmandu" },
  { id: "cu-3", name: "Jonas Berg", company: "Atlas Field Co", email: "jonas@atlasfield.example", plan: "Scale", tier: "Standard", timezone: "Europe/Berlin" },
  { id: "cu-4", name: "Harriet Ellis", company: "Loom & Ledger", email: "harriet@loomledger.example", plan: "Starter", tier: "Standard", timezone: "Europe/London" },
  { id: "cu-5", name: "Maya Trudeau", company: "Beacon Learning", email: "maya@beaconlearning.example", plan: "Growth", tier: "VIP", timezone: "America/Toronto" },
  { id: "cu-6", name: "Tom Ashby", company: "Ropeway Digital", email: "tom@ropeway.example", plan: "Starter", tier: "Standard", timezone: "Australia/Sydney" },
  { id: "cu-7", name: "Aiko Tanaka", company: "Hoshino Works", email: "aiko@hoshino.example", plan: "Scale", tier: "Standard", timezone: "Asia/Tokyo" },
  { id: "cu-8", name: "Priya Nair", company: "Meridian Freight", email: "priya@meridianfreight.example", plan: "Growth", tier: "Standard", timezone: "Asia/Singapore" },
  { id: "cu-9", name: "Rupa Gurung", company: "Kanchen Studio", email: "rupa@kanchen.example", plan: "Starter", tier: "Standard", timezone: "Asia/Kathmandu" },
  { id: "cu-10", name: "Ben Okafor", company: "Trellis Labs", email: "ben@trellis.example", plan: "Scale", tier: "Standard", timezone: "Africa/Lagos" },
]);

export const CANNED_REPLIES = Object.freeze([
  {
    id: "canned-billing",
    label: "Billing · payment not visible",
    body: "Thanks for flagging this. I can see the payment on our side, and the reference is passing through the gateway correctly. I am checking why it has not reached your statement and will come back today with a concrete status rather than a guess.",
  },
  {
    id: "canned-bug",
    label: "Bug · logged with engineering",
    body: "Thank you for the reproduction steps, that is enough for us to dig in. I have logged this with engineering as a high-priority defect and attached your account id. I will update you as soon as there is a fix estimate, even if that estimate is \"not this week\".",
  },
  {
    id: "canned-onboarding",
    label: "Onboarding · invite flow",
    body: "Happy to help. Open Settings → Members → Invite, and choose the Admin role before sending. The invite link is valid for 48 hours; if it expires, you can resend it from the same screen without creating a second seat.",
  },
  {
    id: "canned-security",
    label: "Security · suspicious login",
    body: "I have ended all active sessions on the account and asked our security team to review the sign-in. If you recognise the login, reply here and we will re-enable normal access immediately. If you do not, change your password from a device you trust before signing in again.",
  },
  {
    id: "canned-refund",
    label: "Billing · refund timeline",
    body: "The refund was submitted to the card network today. Card refunds usually appear within 5-10 business days, but the exact date is set by the issuing bank, not by us. I have attached the refund reference so your customer can quote it if they call their bank.",
  },
]);

/** Extended support hours: 08:00-22:00 weekdays, shorter at the weekend. */
const SAMPLE_HOURS = {
  1: [[480, 1320]],
  2: [[480, 1320]],
  3: [[480, 1320]],
  4: [[480, 1320]],
  5: [[480, 1320]],
  6: [[540, 1080]],
  7: [[600, 960]],
};

const dateKeyBack = (now, days) => new Date(now - days * 86_400_000).toISOString().slice(0, 10);

const TICKETS = [
  {
    id: "t-01", number: "DSK-1042", subject: "Refund not showing on the customer's statement",
    customerId: "cu-1", assigneeId: "ag-1", priority: "urgent", status: "open",
    channel: "email", tags: ["billing", "refund"], createdMin: 540,
    history: [["new", 0], ["open", 2]],
    messages: [
      { kind: "customer", after: 0, body: "A refund we processed on 2 October is still not on our customer's statement. The gateway shows it settled. What should we tell their bank?" },
      { kind: "note", after: 30, body: "Checked gateway logs: refund RF-88213 settled at 14:06. The card network reference is missing from the export, asking our payments team for the ARN." },
    ],
  },
  {
    id: "t-02", number: "DSK-1043", subject: "Webhook deliveries stopped at 03:00 UTC",
    customerId: "cu-3", assigneeId: "ag-2", priority: "high", status: "pending_customer",
    channel: "chat", tags: ["api", "webhooks"], createdMin: 300,
    history: [["new", 0], ["open", 3], ["pending_customer", 35]],
    messages: [
      { kind: "customer", after: 0, body: "Our webhook endpoint has received nothing since 03:00 UTC. Retries also fail. We have not changed the endpoint." },
      { kind: "reply", after: 35, body: "I can see 42 failed deliveries since 02:58 UTC, all timing out after 10 seconds. That points at our egress rather than your handler. I have moved the deliveries to the retry queue with a 24-hour backoff and will confirm once the queue drains." },
      { kind: "note", after: 40, body: "Egress incident INC-2291 opened by platform. Do not promise a timestamp until they confirm." },
    ],
  },
  {
    id: "t-03", number: "DSK-1044", subject: "Where do I invite a second admin?",
    customerId: "cu-7", assigneeId: "ag-3", priority: "normal", status: "pending_customer",
    channel: "email", tags: ["onboarding", "account"], createdMin: 360,
    history: [["new", 0], ["open", 5], ["pending_customer", 120]],
    messages: [
      { kind: "customer", after: 0, body: "We need a second admin for our workspace. The Members screen only offers me a Member role." },
      { kind: "reply", after: 120, body: "You are on the Scale plan, so an admin invite is available. On the Members screen, choose Invite, then pick Admin in the role dropdown before sending. If the dropdown is missing, send me the email address and I will add the seat from our side." },
    ],
  },
  {
    id: "t-04", number: "DSK-1045", subject: "Suspicious login from an unknown device",
    customerId: "cu-1", assigneeId: null, priority: "urgent", status: "new",
    channel: "email", tags: ["security", "account"], createdMin: 25,
    history: [["new", 0]],
    messages: [
      { kind: "customer", after: 0, body: "We received a sign-in alert for our billing account from Hanoi. Nobody on the team is travelling. Can you lock the account and tell us what to do next?" },
    ],
  },
  {
    id: "t-05", number: "DSK-1046", subject: "CSV export drops the last row",
    customerId: "cu-5", assigneeId: "ag-2", priority: "high", status: "pending_engineering",
    channel: "email", tags: ["bug", "export"], createdMin: 2880,
    history: [["new", 0], ["open", 6], ["pending_customer", 45], ["open", 180], ["pending_engineering", 300]],
    messages: [
      { kind: "customer", after: 0, body: "Every CSV export is one row short. The visible table shows 500 learners, the file has 499. It is costing us reconciliation time." },
      { kind: "reply", after: 45, body: "I can reproduce this with exactly 500 rows, so it is not your data. I am sending it to engineering with the test workspace attached." },
      { kind: "customer", after: 180, body: "Thanks. Note that the last row is duplicated in the file header when the export includes a filter." },
      { kind: "note", after: 300, body: "Escalated to engineering as EXPORT-311. Suspect the streaming writer flushes before the final row when a filter changes the result set." },
    ],
  },
  {
    id: "t-06", number: "DSK-1047", subject: "Invoice shows the wrong tax rate",
    customerId: "cu-2", assigneeId: "ag-4", priority: "normal", status: "open",
    channel: "email", tags: ["billing", "tax"], createdMin: 1440,
    history: [["new", 0], ["open", 4], ["pending_customer", 180], ["open", 240]],
    messages: [
      { kind: "customer", after: 0, body: "Invoice INV-2026-0047 shows 13% tax on a line that should be zero-rated. Can you reissue it?" },
      { kind: "reply", after: 180, body: "You are right: the line was created on an export invoice and inherited the domestic default. I have corrected the invoice and will reissue it after you confirm the billing entity." },
      { kind: "customer", after: 240, body: "Confirmed, the billing entity is the same one. Please reissue with the same number plus a suffix." },
    ],
  },
  {
    id: "t-07", number: "DSK-1048", subject: "Dark mode for the dashboard?",
    customerId: "cu-6", assigneeId: "ag-1", priority: "low", status: "open",
    channel: "email", tags: ["feature request", "dashboard"], createdMin: 2880,
    history: [["new", 0], ["open", 8], ["pending_customer", 240], ["open", 600]],
    messages: [
      { kind: "customer", after: 0, body: "Any plans for a dark theme? Our analysts work late and the dashboard is very bright." },
      { kind: "reply", after: 240, body: "It is on the roadmap but I cannot promise a release. There is a browser-level workaround (forced dark) that mostly works on the charts, I can send the flags." },
      { kind: "customer", after: 600, body: "Forced dark breaks the legend colours. I will wait for the real thing, just wanted to add another vote." },
    ],
  },
  {
    id: "t-08", number: "DSK-1049", subject: "Password reset email never arrives",
    customerId: "cu-4", assigneeId: "ag-3", priority: "normal", status: "resolved",
    channel: "chat", tags: ["auth", "email"], createdMin: 5760,
    history: [["new", 0], ["open", 2], ["resolved", 150]],
    messages: [
      { kind: "customer", after: 0, body: "Three reset attempts, no email, including spam. Our mail provider says nothing arrived." },
      { kind: "reply", after: 20, body: "Your domain has a DMARC reject policy and our reset sender was misaligned. I have triggered the reset from the corrected sender, it should arrive within two minutes." },
      { kind: "customer", after: 130, body: "Arrived, thank you. We should fix the alignment properly though." },
      { kind: "note", after: 140, body: "Opened EMAIL-88 for the DMARC alignment fix; not blocking this ticket." },
    ],
    csat: { score: 5, after: 200, comment: "Fast diagnosis, and they explained why it happened." },
  },
  {
    id: "t-09", number: "DSK-1050", subject: "Shopify import repeating variants",
    customerId: "cu-8", assigneeId: "ag-2", priority: "high", status: "resolved",
    channel: "email", tags: ["integration", "import"], createdMin: 4320,
    history: [["new", 0], ["open", 5], ["pending_customer", 40], ["open", 120], ["resolved", 300]],
    messages: [
      { kind: "customer", after: 0, body: "The Shopify import creates each variant twice when a product has more than three options." },
      { kind: "reply", after: 40, body: "I found the duplicate detection key only includes the first three options, so a fourth option falls through. Working on a fix with a dry-run so you can test before touching the catalogue." },
      { kind: "customer", after: 120, body: "A dry run would be perfect. We have about 1,900 products." },
      { kind: "note", after: 200, body: "Fix deployed behind the import flag; refunded one month of the integration add-on as goodwill." },
    ],
    csat: { score: 4, after: 360, comment: "Good fix. Would have liked an earlier estimate." },
  },
  {
    id: "t-10", number: "DSK-1051", subject: "Can I change my billing email?",
    customerId: "cu-9", assigneeId: "ag-4", priority: "normal", status: "closed",
    channel: "chat", tags: ["billing", "account"], createdMin: 7200,
    history: [["new", 0], ["open", 3], ["resolved", 500], ["closed", 560]],
    messages: [
      { kind: "customer", after: 0, body: "Our finance address changed. Can I update where invoices are sent without changing the login email?" },
      { kind: "reply", after: 60, body: "Yes, Billing → Invoice recipients is separate from the login email. Add the new address there and remove the old one; the next invoice will use it." },
    ],
    csat: { score: 3, after: 620, comment: "Answer was right but it took most of a day." },
  },
  {
    id: "t-11", number: "DSK-1052", subject: "All API calls returning 502",
    customerId: "cu-1", assigneeId: "ag-2", priority: "urgent", status: "open",
    channel: "chat", tags: ["outage", "api"], createdMin: 40,
    history: [["new", 0], ["open", 1]],
    messages: [
      { kind: "customer", after: 0, body: "Every request since 19:40 is a 502. The status page still says operational. This is taking down our intake form." },
      { kind: "note", after: 12, body: "Confirmed: 502s from the edge, origin healthy. Paging platform on-call; do not tell the customer it is their integration." },
    ],
  },
  {
    id: "t-12", number: "DSK-1053", subject: "Bulk tag editing for tickets",
    customerId: "cu-10", assigneeId: "ag-3", priority: "low", status: "closed",
    channel: "email", tags: ["feature request", "workflow"], createdMin: 10080,
    history: [["new", 0], ["open", 10], ["resolved", 1200], ["closed", 1300]],
    messages: [
      { kind: "customer", after: 0, body: "We need to tag 200 tickets at once after an incident. Doing it one by one is not viable." },
      { kind: "reply", after: 300, body: "Bulk tagging is not in the current release, so I am closing this as a tracked feature request rather than leaving it open indefinitely. You can multi-select in the list view today and apply one tag; unlimited tags per bulk action is the part missing." },
    ],
  },
  {
    id: "t-13", number: "DSK-1054", subject: "Exports time out above 50k rows",
    customerId: "cu-7", assigneeId: "ag-1", priority: "high", status: "open",
    channel: "email", tags: ["bug", "export"], createdMin: 180,
    history: [["new", 0], ["open", 7]],
    messages: [
      { kind: "customer", after: 0, body: "Every export over roughly 50,000 rows fails with a gateway timeout after 30 seconds. Smaller exports work." },
      { kind: "note", after: 25, body: "Reproduced with 60k rows. The export runs synchronously in the request. Needs the async job path, not a support fix." },
    ],
  },
  {
    id: "t-14", number: "DSK-1055", subject: "Bulk tag editing for the whole workspace",
    customerId: "cu-9", assigneeId: "ag-2", priority: "normal", status: "pending_engineering",
    channel: "email", tags: ["feature request", "workflow"], createdMin: 4320,
    history: [["new", 0], ["open", 6], ["pending_customer", 90], ["open", 200], ["pending_engineering", 320]],
    messages: [
      { kind: "customer", after: 0, body: "Following up on the bulk tagging request, is this planned for this quarter?" },
      { kind: "reply", after: 90, body: "Not this quarter, but the workflow team is scoping it. I have linked your workspace to the request so you will get an update if it moves." },
      { kind: "customer", after: 200, body: "Understood. One more thing: can tags be renamed without detaching them?" },
      { kind: "note", after: 320, body: "Moved to engineering for the rename question specifically; it is a data model issue, not a UI one." },
    ],
  },
  {
    id: "t-15", number: "DSK-1056", subject: "Two-factor codes rejected after clocks changed",
    customerId: "cu-10", assigneeId: "ag-1", priority: "high", status: "resolved",
    channel: "chat", tags: ["security", "2fa"], createdMin: 8640,
    history: [["new", 0], ["open", 4], ["pending_customer", 30], ["open", 90], ["resolved", 420]],
    messages: [
      { kind: "customer", after: 0, body: "After the DST change, every TOTP code is rejected as expired. Our whole team is locked out." },
      { kind: "reply", after: 30, body: "The code window is being calculated in local time instead of UTC, so the server sees codes an hour early. I have widened the acceptance window for your workspace while we ship a fix, try a fresh code now." },
      { kind: "customer", after: 90, body: "Working. Please do not forget the permanent fix; widened windows are a security trade-off." },
      { kind: "note", after: 200, body: "Fix released in 2.14.1. Window narrowed back to ±1 step on the next sign-in." },
    ],
    csat: { score: 5, after: 480, comment: "Clear explanation of a subtle bug. Great incident writing." },
  },
  {
    id: "t-16", number: "DSK-1057", subject: "Charged twice for September",
    customerId: "cu-5", assigneeId: "ag-4", priority: "normal", status: "closed",
    channel: "email", tags: ["billing", "refund"], createdMin: 11520,
    history: [["new", 0], ["open", 5], ["resolved", 600], ["closed", 700]],
    messages: [
      { kind: "customer", after: 0, body: "We were charged twice on 3 September, invoice 0048 and 0049. Please refund one and confirm." },
      { kind: "reply", after: 90, body: "Confirmed: the retry scheduler re-issued invoice 0049 after a gateway timeout, even though the first charge succeeded. The duplicate is refunded; the reference is RF-77310." },
      { kind: "customer", after: 400, body: "Refund received. The duplicate invoice should be voided too, not left on the account." },
      { kind: "note", after: 520, body: "Voided 0049 and added a note to the billing audit trail." },
    ],
    csat: { score: 2, after: 750, comment: "Took three replies to get both the refund and the void. The refund itself was fine." },
  },
  {
    id: "t-17", number: "DSK-1058", subject: "Importing contacts from a CSV with commas in names",
    customerId: "cu-8", assigneeId: "ag-3", priority: "normal", status: "resolved",
    channel: "email", tags: ["onboarding", "import"], createdMin: 6000,
    history: [["new", 0], ["open", 4], ["resolved", 300]],
    messages: [
      { kind: "customer", after: 0, body: "The CSV importer splits names at commas, so \"Nair, Priya\" becomes two contacts." },
      { kind: "reply", after: 60, body: "The importer follows RFC 4180, so the field needs to be quoted: \"Nair, Priya\". If you export from Excel with UTF-8 CSV it will quote automatically. I have fixed the two broken contacts in your workspace." },
      { kind: "customer", after: 260, body: "That worked. A preview step before committing would have saved us the mess, though." },
    ],
    csat: { score: 4, after: 330, comment: "Helpful fix. Preview before import would make it a five." },
  },
];

function buildTicket(template, now) {
  const createdAt = now - template.createdMin * MINUTE;
  const history = template.history.map(([status, after]) => ({
    status,
    at: createdAt + after * MINUTE,
    event: status === "new" ? "created" : `to_${status}`,
    actorId: template.assigneeId,
    note: null,
  }));
  const last = history[history.length - 1];
  if (last.status !== template.status) {
    throw new Error(`${template.number}: history ends in ${last.status}, template says ${template.status}`);
  }
  const messages = template.messages.map((message, index) => ({
    id: `${template.id}-m${index + 1}`,
    kind: message.kind,
    authorId: message.kind === "customer" ? template.customerId : (message.authorId || template.assigneeId || "ag-1"),
    at: createdAt + message.after * MINUTE,
    body: message.body,
  }));
  const csat = template.csat
    ? {
      score: template.csat.score,
      at: createdAt + template.csat.after * MINUTE,
      comment: template.csat.comment,
    }
    : null;
  const updatedAt = Math.max(
    ...history.map((entry) => entry.at),
    ...messages.map((message) => message.at),
    csat ? csat.at : 0,
  );
  return {
    id: template.id,
    number: template.number,
    subject: template.subject,
    customerId: template.customerId,
    assigneeId: template.assigneeId,
    priority: template.priority,
    status: template.status,
    channel: template.channel,
    tags: template.tags,
    createdAt,
    updatedAt,
    history,
    messages,
    csat,
  };
}

export function buildSampleData({ now = Date.now() } = {}) {
  return {
    agents: AGENTS,
    customers: CUSTOMERS,
    cannedReplies: CANNED_REPLIES,
    currentAgentId: "ag-1",
    calendar: createCalendar({
      offsetMinutes: 345,
      hours: SAMPLE_HOURS,
      holidays: [dateKeyBack(now, 9), dateKeyBack(now, 10)],
    }),
    tickets: TICKETS.map((template) => buildTicket(template, now)),
    meta: {
      generatedAt: now,
      label: "Sample workspace, 17 tickets for 10 fictional customers",
    },
  };
}
