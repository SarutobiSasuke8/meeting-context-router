const tokenInput = document.getElementById("api-token");
const proposalList = document.getElementById("proposal-list");
const filter = document.getElementById("status-filter");
const systemStatus = document.getElementById("system-status");
const intakeStatus = document.getElementById("intake-status");
const manualPayload = document.getElementById("manual-payload");

manualPayload.value = JSON.stringify({
  sourceMeetingId: `manual-${new Date().toISOString().slice(0, 10)}-demo`,
  title: "Partner working session",
  startedAt: new Date().toISOString(),
  endedAt: null,
  participants: [{ name: "Alexei Udall", email: null, external: false }],
  summary: "Reviewed the proposed meeting context workflow and agreed to test the Obsidian route first.",
  decisions: ["Keep n8n outside the core architecture."],
  actionItems: [{ description: "Run one quarantined dogfood import", assigneeName: "Alexei Udall", completed: false }],
  transcript: []
}, null, 2);

function apiHeaders(hasBody = false) {
  const headers = {};
  if (hasBody) headers["content-type"] = "application/json";
  if (tokenInput.value) headers.authorization = `Bearer ${tokenInput.value}`;
  return headers;
}

async function api(path, options = {}) {
  const response = await fetch(path, { ...options, headers: { ...apiHeaders(Boolean(options.body)), ...(options.headers || {}) } });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error?.message || `HTTP ${response.status}`);
  return body;
}

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function actionButton(label, className, handler) {
  const button = element("button", `button ${className}`, label);
  button.type = "button";
  button.addEventListener("click", async () => {
    button.disabled = true;
    try { await handler(); } finally { button.disabled = false; }
  });
  return button;
}

function renderProposal(proposal) {
  const card = element("article", "proposal");
  const head = element("div", "proposal-head");
  const titleBlock = element("div");
  titleBlock.append(element("span", "proposal-target", proposal.target), element("h3", "", proposal.operation.replaceAll("_", " ")));
  head.append(titleBlock, element("span", `status-pill ${proposal.status}`, proposal.status));
  card.append(head);

  const meta = element("div", "proposal-meta");
  meta.append(element("span", "", `Confidence ${Math.round(proposal.confidence * 100)}%`), element("span", "", `Meeting ${proposal.meetingId.slice(0, 8)}`), element("span", "", `${proposal.evidence.length} evidence marker(s)`));
  card.append(meta);

  if (proposal.lastError) card.append(element("p", "error-copy", proposal.lastError));
  const details = element("details");
  details.append(element("summary", "", "Inspect proposed payload"), element("pre", "", JSON.stringify(proposal.payload, null, 2)));
  card.append(details);

  const actions = element("div", "proposal-actions");
  if (proposal.status === "pending") {
    actions.append(
      actionButton("Approve", "primary", () => proposalAction(proposal.id, "approve")),
      actionButton("Reject", "danger", () => proposalAction(proposal.id, "reject"))
    );
  }
  if (["approved", "blocked", "failed"].includes(proposal.status)) {
    actions.append(actionButton(proposal.status === "approved" ? "Deliver" : "Retry delivery", "secondary", () => proposalAction(proposal.id, "deliver")));
  }
  card.append(actions);
  return card;
}

async function proposalAction(id, action) {
  systemStatus.textContent = `${action} in progress…`;
  try {
    await api(`/v1/proposals/${id}/${action}`, { method: "POST" });
    systemStatus.textContent = `${action} complete`;
  } catch (error) {
    systemStatus.textContent = error.message;
  }
  await refresh();
}

async function refresh() {
  proposalList.replaceChildren(element("p", "empty", "Loading proposals…"));
  try {
    const all = (await api("/v1/proposals")).data;
    for (const status of ["pending", "approved", "delivered", "blocked"]) {
      document.getElementById(`${status}-count`).textContent = String(all.filter((proposal) => proposal.status === status).length);
    }
    const selected = filter.value ? all.filter((proposal) => proposal.status === filter.value) : all;
    proposalList.replaceChildren(...(selected.length ? selected.map(renderProposal) : [element("p", "empty", "Nothing in this queue.")]));
    const health = await api("/health/ready");
    systemStatus.textContent = `Ready · Fathom ${health.fathomConfigured ? "configured" : "off"} · CRM ${health.crmConfigured ? "configured" : "awaiting endpoint"}`;
  } catch (error) {
    proposalList.replaceChildren(element("p", "empty", error.message));
    systemStatus.textContent = error.message;
  }
}

document.getElementById("refresh").addEventListener("click", refresh);
filter.addEventListener("change", refresh);
tokenInput.addEventListener("change", refresh);
document.getElementById("import-meeting").addEventListener("click", async () => {
  intakeStatus.textContent = "Validating…";
  try {
    const payload = JSON.parse(manualPayload.value);
    const result = await api("/v1/intake/manual", { method: "POST", body: JSON.stringify(payload) });
    intakeStatus.textContent = result.data.duplicate ? "Already ingested; existing proposals returned." : "Two destination proposals created. Nothing delivered.";
    await refresh();
  } catch (error) {
    intakeStatus.textContent = error.message;
  }
});

refresh();
