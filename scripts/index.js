const WORKER_BASE_URL = "https://grantwriter.bodhishanbhag.workers.dev";
const CHAT_URL = `${WORKER_BASE_URL}/chat`;
const PDF_URL = `${WORKER_BASE_URL}/pdf`;
const STORAGE_KEY = "grant-writer-conversation-v1";

const REQUIRED_FIELDS = [
  { path: "organization.name", label: "Organization / Tribe Name", type: "text", section: "Organization" },
  { path: "organization.type", label: "Organization Type", type: "text", section: "Organization" },
  { path: "organization.contactName", label: "Contact Name", type: "text", section: "Organization" },
  { path: "organization.contactEmail", label: "Contact Email", type: "email", section: "Organization" },
  { path: "project.title", label: "Project Title", type: "text", section: "Project" },
  { path: "project.requestedAmount", label: "Requested Amount", type: "text", section: "Project" },
  { path: "project.periodEnd", label: "Project Period End", type: "date", section: "Project" },
  { path: "narrative.statementOfNeed", label: "Statement of Need", type: "textarea", section: "Narrative" },
  { path: "narrative.projectDescription", label: "Project Description", type: "textarea", section: "Narrative" },
  { path: "narrative.goalsAndObjectives", label: "Goals and Objectives", type: "textarea", section: "Narrative" },
  { path: "narrative.methodology", label: "Methodology", type: "textarea", section: "Narrative" },
  { path: "budget.totalProjectCost", label: "Total Project Cost", type: "text", section: "Budget" },
];

const state = {
  messages: [],
  payload: {
    organization: {},
    project: {},
    narrative: {},
    budget: {},
    additionalNotes: "",
  },
};

const chatMessages = document.getElementById("chatMessages");
const chatForm = document.getElementById("chatForm");
const chatInput = document.getElementById("chatInput");
const doneBtn = document.getElementById("doneBtn");
const sendBtn = document.getElementById("sendBtn");
const missingPanel = document.getElementById("missingPanel");
const missingForm = document.getElementById("missingForm");
const generateBtn = document.getElementById("generateBtn");
const statusEl = document.getElementById("status");
const guideText = document.getElementById("guideText");
const thinkingIndicator = document.getElementById("thinkingIndicator");
const guideVideo = document.querySelector(".guide-video");
const progressRing = document.getElementById("progressRing");
const progressPercent = document.getElementById("progressPercent");
const plantVideo = document.querySelector(".plant-video");
const GUIDE_WAVING_VIDEO = "images/Gnome%20Waving.mp4";
const GUIDE_THINKING_VIDEO = "images/Grant_Thinking.mp4";

if (plantVideo) plantVideo.playbackRate = 0.25;

const restoredConversation = loadSavedConversation();
if (restoredConversation) {
  state.messages = restoredConversation.messages;
  state.payload = mergePayload(state.payload, restoredConversation.payload);
  state.messages.forEach((message) => renderMessage(message.role, message.content));
  const lastAssistantMessage = [...state.messages].reverse().find((message) => message.role === "assistant");
  if (lastAssistantMessage) guideText.textContent = lastAssistantMessage.content;
} else {
  addMessage(
    "assistant",
    "Hi, I'm Grant. Start by telling me what project you want funded, who it helps, and what you are asking the government or funder to pay for."
  );
}
updateProgressGarden();

chatForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const text = chatInput.value.trim();
  if (!text) return;
  chatInput.value = "";
  await sendChat(text, false);
});

doneBtn.addEventListener("click", async () => {
  await sendChat("I'm done explaining. Please check what is still missing.", true);
});

generateBtn.addEventListener("click", generatePdf);
missingForm.addEventListener("input", () => {
  applyMissingFormValues();
  updateGenerateButtonState();
});

function addMessage(role, text) {
  state.messages.push({ role, content: text });
  renderMessage(role, text);
  saveConversation();
}

function loadSavedConversation() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || "null");
    if (!saved || !Array.isArray(saved.messages) || !saved.messages.length) return null;

    const messages = saved.messages.filter(
      (message) => message && (message.role === "assistant" || message.role === "user") && typeof message.content === "string"
    );
    if (!messages.length) return null;

    return {
      messages,
      payload: saved.payload && typeof saved.payload === "object" ? saved.payload : {},
    };
  } catch (_) {
    return null;
  }
}

function saveConversation() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      messages: state.messages,
      payload: state.payload,
    }));
  } catch (_) {
    // localStorage isn't always available (file:// pages, private browsing)
  }
}

function updateProgressGarden() {
  if (!progressRing || !progressPercent) return;
  const filledCount = REQUIRED_FIELDS.filter((field) => String(getPath(state.payload, field.path)).trim()).length;
  const percentage = Math.round((filledCount / REQUIRED_FIELDS.length) * 100);
  progressRing.style.setProperty("--progress", `${percentage * 3.6}deg`);
  progressPercent.textContent = `${percentage}%`;
  progressRing.setAttribute("aria-label", `${percentage}% of required grant details filled`);
}

function renderMessage(role, text) {
  const messageRow = document.createElement("div");
  messageRow.className = `chat-message-row ${role}`;

  if (role === "assistant") {
    const avatar = document.createElement("div");
    avatar.className = "chat-avatar message-avatar";
    avatar.setAttribute("aria-hidden", "true");
    const image = document.createElement("img");
    image.src = "images/grant.png";
    image.alt = "";
    avatar.appendChild(image);
    messageRow.appendChild(avatar);
  }

  const message = document.createElement("div");
  message.className = `chat-message ${role}`;
  message.textContent = text;
  messageRow.appendChild(message);
  chatMessages.appendChild(messageRow);
  chatMessages.scrollTop = chatMessages.scrollHeight;
}

async function sendChat(text, finishRequested) {
  addMessage("user", text);
  setBusy(true, finishRequested ? "Grant is checking for missing details..." : "Grant is thinking...");

  try {
    const response = await fetch(CHAT_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        messages: state.messages,
        payload: state.payload,
        finishRequested,
      }),
    });

    const body = await response.json();
    if (!response.ok) throw new Error(body.error || `Chat failed (${response.status})`);

    state.payload = mergePayload(state.payload, body.payload || {});
    saveConversation();
    updateProgressGarden();
    const reply = body.assistantMessage || "I updated the draft notes. Tell me anything else I should know.";
    addMessage("assistant", reply);
    guideText.textContent = reply;

    if (finishRequested) {
      renderMissingFields(body.missingRequired || getMissingRequiredFields());
    }
  } catch (err) {
    const fallback = "I could not reach the AI chat right now. You can still use the missing-fields panel to generate once the required details are filled in.";
    addMessage("assistant", fallback);
    guideText.textContent = fallback;
    if (finishRequested) renderMissingFields(getMissingRequiredFields());
    statusEl.textContent = String(err.message || err);
  } finally {
    setBusy(false);
  }
}

function setBusy(isBusy, message = "") {
  sendBtn.disabled = isBusy;
  doneBtn.disabled = isBusy;
  chatInput.disabled = isBusy;
  statusEl.textContent = message;
  setGuideAnimation(isBusy);
  if (isBusy) {
    chatMessages.appendChild(thinkingIndicator);
    thinkingIndicator.hidden = false;
    chatMessages.scrollTop = chatMessages.scrollHeight;
  } else {
    thinkingIndicator.hidden = true;
  }
}

function setGuideAnimation(isThinking) {
  if (!guideVideo) return;
  const nextSource = isThinking ? GUIDE_THINKING_VIDEO : GUIDE_WAVING_VIDEO;
  if (guideVideo.getAttribute("src") === nextSource) return;

  guideVideo.setAttribute("src", nextSource);
  guideVideo.load();
  guideVideo.play().catch(() => {});
}

function mergePayload(base, update) {
  const merged = structuredCloneSafe(base);
  mergeObject(merged, update);
  return merged;
}

function mergeObject(target, source) {
  if (!source || typeof source !== "object") return target;
  // empty values never overwrite something we already have
  Object.entries(source).forEach(([key, value]) => {
    if (value === null || value === undefined || value === "") return;
    if (Array.isArray(value)) {
      target[key] = value.slice();
    } else if (typeof value === "object") {
      if (!target[key] || typeof target[key] !== "object") target[key] = {};
      mergeObject(target[key], value);
    } else {
      target[key] = value;
    }
  });
  return target;
}

function structuredCloneSafe(value) {
  return JSON.parse(JSON.stringify(value || {}));
}

function getMissingRequiredFields() {
  return REQUIRED_FIELDS.filter((field) => !getPath(state.payload, field.path));
}

function renderMissingFields(fields) {
  const missing = fields && fields.length ? fields : getMissingRequiredFields();
  missingForm.innerHTML = "";
  missingPanel.hidden = false;

  if (!missing.length) {
    const complete = document.createElement("p");
    complete.className = "complete-note";
    complete.textContent = "Grant found all required details. You can generate the PDF now.";
    missingForm.appendChild(complete);
    updateGenerateButtonState();
    guideText.textContent = "I have the required pieces. Generate the PDF, then review the warnings before submitting anywhere.";
    return;
  }

  missing.forEach((field) => {
    const def = typeof field === "string"
      ? REQUIRED_FIELDS.find((item) => item.path === field)
      : REQUIRED_FIELDS.find((item) => item.path === field.path) || field;
    if (!def) return;

    const label = document.createElement("label");
    label.className = "field missing-field";
    if (def.type === "textarea") label.classList.add("missing-field-wide");
    label.textContent = `${def.label} `;

    const star = document.createElement("span");
    star.className = "required-mark";
    star.textContent = "*";
    label.appendChild(star);

    const input = def.type === "textarea" ? document.createElement("textarea") : document.createElement("input");
    input.name = def.path;
    input.required = true;
    if (def.type !== "textarea") input.type = def.type || "text";
    if (def.type === "textarea") input.rows = 4;
    input.value = getPath(state.payload, def.path) || "";
    label.appendChild(input);
    missingForm.appendChild(label);
  });

  updateGenerateButtonState();
  guideText.textContent = "Nice. I pulled out what I could. Fill the starred leftovers, then I can make the PDF draft.";
  missingPanel.scrollIntoView({ behavior: "smooth", block: "start" });
}

function updateGenerateButtonState() {
  generateBtn.disabled = missingPanel.hidden || getMissingRequiredFields().length > 0;
}

function applyMissingFormValues() {
  const fields = missingForm.querySelectorAll("input[name], textarea[name]");
  fields.forEach((field) => {
    setPath(state.payload, field.name, field.value.trim());
  });
  saveConversation();
  updateProgressGarden();
}

function validateMissingForm() {
  applyMissingFormValues();
  const firstInvalid = missingForm.querySelector(":invalid");
  if (!firstInvalid) return true;
  statusEl.textContent = "Please fill out the starred fields before generating the PDF.";
  firstInvalid.reportValidity();
  firstInvalid.focus();
  return false;
}

function buildPayloadForPdf() {
  applyMissingFormValues();
  const payload = structuredCloneSafe(state.payload);
  payload.additionalNotes = [
    payload.additionalNotes,
    "Conversation transcript:",
    ...state.messages.map((message) => `${message.role}: ${message.content}`),
  ].filter(Boolean).join("\n\n");
  return payload;
}

async function generatePdf() {
  if (!validateMissingForm()) return;

  const missing = getMissingRequiredFields();
  if (missing.length) {
    renderMissingFields(missing);
    statusEl.textContent = "Grant still needs the starred fields before generating.";
    return;
  }

  statusEl.textContent = "Generating PDF... this can take 15-30 seconds.";
  // timeline of this request, merged with the backend's own log later
  const requestId = Math.random().toString(36).slice(2, 8);
  const clientStart = Date.now();
  const clientEvents = [];
  const clientLog = (step, detail) => {
    const entry = { t: Date.now() - clientStart, step, detail };
    clientEvents.push(entry);
    console.log(`[grant-writer +${entry.t}ms] [CLIENT] ${step}${detail ? ": " + detail : ""}`);
  };

  const payload = buildPayloadForPdf();
  clientLog("chat:payload ready", `org="${(payload.organization || {}).name || ""}"`);

  try {
    const response = await fetch(PDF_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    clientLog("pdf:response received", `status ${response.status}`);

    if (!response.ok) {
      let message = `Request failed (${response.status})`;
      let backendLog = null;
      try {
        const errBody = await response.json();
        message = errBody.error || message;
        if (errBody.details) message += `: ${errBody.details}`;
        backendLog = errBody.debugLog || null;
      } catch (_) {}
      clientLog("error", message);
      printDebugTrace(clientEvents, backendLog, requestId);
      document.getElementById("warnings").innerHTML = "";
      statusEl.textContent = message;
      return;
    }

    const backendLog = parseDebugHeader(response);
    const warnings = parseWarningsHeader(response);
    renderWarnings(warnings);

    const blob = await response.blob();
    const url = URL.createObjectURL(blob);
    const orgName = payload.organization && payload.organization.name
      ? payload.organization.name.replace(/[^a-z0-9]+/gi, "_")
      : "grant";

    const link = document.createElement("a");
    link.href = url;
    link.download = `${orgName}_grant_draft.pdf`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);

    printDebugTrace(clientEvents, backendLog, requestId);
    statusEl.textContent = "PDF downloaded. Review the compliance checklist before submitting anywhere.";
  } catch (err) {
    clientLog("pdf:failed", String(err));
    printDebugTrace(clientEvents, null, requestId);
    statusEl.textContent = "Failed to reach the server: " + err;
  }
}

function getPath(obj, path) {
  return path.split(".").reduce((cursor, part) => {
    if (!cursor || typeof cursor !== "object") return "";
    return cursor[part];
  }, obj) || "";
}

function setPath(obj, path, value) {
  const parts = path.split(".");
  let cursor = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    if (!cursor[parts[i]] || typeof cursor[parts[i]] !== "object") cursor[parts[i]] = {};
    cursor = cursor[parts[i]];
  }
  cursor[parts[parts.length - 1]] = value;
}

function printDebugTrace(clientEvents, backendLog, requestId) {
  try {
    console.groupCollapsed(`[grant-writer] request ${requestId} trace`);
    const merged = [
      ...clientEvents.map((e) => ({ ...e, side: "client" })),
      ...(Array.isArray(backendLog) ? backendLog : []).map((e) => ({ ...e, side: "server" })),
    ].sort((a, b) => a.t - b.t);

    if (merged.length === 0) console.log("(no debug entries)");
    for (const e of merged) {
      const tag = e.side === "client" ? "CLIENT" : "SERVER";
      console.log(`+${e.t}ms [${tag}] ${e.step}${e.detail ? ": " + e.detail : ""}`);
    }
    console.groupEnd();
  } catch (err) {
    console.error("[grant-writer] failed to print debug trace", err);
  }
}

function parseDebugHeader(response) {
  const raw = response.headers.get("X-Grant-Debug");
  if (!raw) return null;
  try {
    return JSON.parse(decodeURIComponent(raw));
  } catch (err) {
    console.warn("[grant-writer] could not parse X-Grant-Debug header", err);
    return null;
  }
}

function parseWarningsHeader(response) {
  const raw = response.headers.get("X-Grant-Warnings");
  if (!raw) return null;
  try {
    return JSON.parse(decodeURIComponent(raw));
  } catch (err) {
    console.warn("[grant-writer] could not parse X-Grant-Warnings header", err);
    return null;
  }
}

// Shows where the RFA requirements actually came from, so nobody
// submits a draft trusting an unverified source.
function renderWarnings(warnings) {
  const container = document.getElementById("warnings");
  container.innerHTML = "";
  if (!warnings) return;

  const heading = document.createElement("h2");
  heading.textContent = "Before you submit this draft";
  container.appendChild(heading);

  const origin = warnings.rfaSourceOrigin;
  const originP = document.createElement("p");
  if (origin === "user-provided") {
    originP.textContent = "Funder requirements were grounded in the RFA URL/text you provided.";
  } else if (origin === "automated-web-search") {
    originP.textContent = "Funder requirements were found via an automated web search, not verified by a human. Confirm the source matches your target program.";
  } else {
    originP.textContent = "No RFA URL/text was provided or found. Provide the real RFA link or text and regenerate before submitting.";
  }
  container.appendChild(originP);

  if (warnings.rfaFetchNote) {
    const noteP = document.createElement("p");
    noteP.textContent = "Note: " + warnings.rfaFetchNote;
    container.appendChild(noteP);
  }

  if (warnings.fundingRequirementsSummary) {
    const label = document.createElement("p");
    label.innerHTML = "<strong>Funding requirements summary:</strong>";
    container.appendChild(label);
    const p = document.createElement("p");
    p.textContent = warnings.fundingRequirementsSummary;
    container.appendChild(p);
  }

  if (Array.isArray(warnings.complianceChecklist) && warnings.complianceChecklist.length > 0) {
    const label = document.createElement("p");
    label.innerHTML = "<strong>Compliance checklist -- verify before submitting:</strong>";
    container.appendChild(label);
    const ul = document.createElement("ul");
    warnings.complianceChecklist.forEach((item) => {
      const li = document.createElement("li");
      li.textContent = item;
      ul.appendChild(li);
    });
    container.appendChild(ul);
  }
}
