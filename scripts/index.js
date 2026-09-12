const WORKER_URL = "https://grantwriter.bodhishanbhag.workers.dev/pdf";

// ---------------------------------------------------------------
// Wizard paging: show one fieldset at a time. Uses the native HTML
// `hidden` attribute to show/hide -- no CSS involved.
// ---------------------------------------------------------------
const STEPS = [
  "step-organization",
  "step-project",
  "step-narrative",
  "step-budget",
  "step-notes",
];
const STEP_LABELS = ["Organization", "Project", "Narrative", "Budget", "Additional Notes"];
let currentStep = 0;

function showStep(index) {
  STEPS.forEach((id, i) => {
    const el = document.getElementById(id);
    if (el) el.hidden = i !== index;
  });
  document.getElementById("backBtn").hidden = index === 0;
  document.getElementById("nextBtn").hidden = index === STEPS.length - 1;
  document.getElementById("generateBtn").hidden = index !== STEPS.length - 1;
  document.getElementById("stepLabel").textContent =
    `Step ${index + 1} of ${STEPS.length}: ${STEP_LABELS[index]}`;
  currentStep = index;
}

function nextStep() {
  if (currentStep < STEPS.length - 1) showStep(currentStep + 1);
}

function prevStep() {
  if (currentStep > 0) showStep(currentStep - 1);
}

// Initialize on load (script tag is at the end of <body>, so the
// fieldsets already exist in the DOM by the time this runs).
showStep(0);

/**
 * Reads every input/textarea in #grantForm by its dotted `name`
 * attribute (e.g. "organization.name") and builds the nested JSON
 * object matching SCHEMA.md.
 */
function buildPayloadFromForm() {
  const form = document.getElementById("grantForm");
  const payload = {};

  const fields = form.querySelectorAll("input[name], textarea[name]");
  fields.forEach((field) => {
    const path = field.name.split(".");
    let cursor = payload;
    for (let i = 0; i < path.length - 1; i++) {
      const key = path[i];
      if (!cursor[key] || typeof cursor[key] !== "object") {
        cursor[key] = {};
      }
      cursor = cursor[key];
    }
    cursor[path[path.length - 1]] = field.value;
  });

  return payload;
}

/**
 * Prints the backend's step-by-step debug log (sent as the
 * X-Grant-Debug header on /pdf responses, or inline as `debugLog` in
 * JSON error bodies) into the browser console, interleaved with a
 * frontend-side timeline, all under one console.group so the whole
 * request is inspectable in one place -- open DevTools (F12) ->
 * Console to see it. Never throws; logging failures never break the
 * actual request.
 */
function printDebugTrace(clientEvents, backendLog, requestId) {
  try {
    console.groupCollapsed(`[grant-writer] request ${requestId} trace`);

    const merged = [
      ...clientEvents.map((e) => ({ ...e, side: "client" })),
      ...(Array.isArray(backendLog) ? backendLog : []).map((e) => ({
        ...e,
        side: "server",
      })),
    ].sort((a, b) => a.t - b.t);

    if (merged.length === 0) {
      console.log("(no debug entries -- backend may not have returned X-Grant-Debug)");
    }
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

/**
 * Renders everything intentionally left OUT of the submittable PDF --
 * RFA sourcing status, the compliance checklist, funding requirements
 * summary, and a preview of any raw retrieved RFA text -- as plain
 * text/list elements on the page itself, not just the console. This
 * is where the applicant is meant to actually see these before
 * deciding the draft is ready.
 */
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
    originP.textContent =
      "Funder requirements were found via an AUTOMATED web search, not verified by a human. Confirm the source actually matches your target program before relying on it.";
  } else {
    originP.textContent =
      "No RFA URL/text was provided or found. The draft's content is NOT grounded in a specific funder's requirements -- provide the real RFA link or text and regenerate before submitting.";
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

  if (warnings.rfaRawTextPreview) {
    const details = document.createElement("details");
    const summary = document.createElement("summary");
    summary.textContent = "Raw retrieved RFA/search text (unedited, for your own verification)";
    details.appendChild(summary);
    const pre = document.createElement("pre");
    pre.textContent = warnings.rfaRawTextPreview;
    details.appendChild(pre);
    container.appendChild(details);
  }
}

async function generatePdf() {
  const status = document.getElementById("status");
  status.textContent = "Generating PDF... this can take 15-30 seconds.";

  const requestId = Math.random().toString(36).slice(2, 8);
  const clientStart = Date.now();
  const clientEvents = [];
  const clientLog = (step, detail) => {
    const entry = { t: Date.now() - clientStart, step, detail };
    clientEvents.push(entry);
    console.log(`[grant-writer +${entry.t}ms] [CLIENT] ${step}${detail ? ": " + detail : ""}`);
  };

  clientLog("form:building payload");
  const payload = buildPayloadFromForm();
  clientLog("form:payload built", `org="${(payload.organization || {}).name || ""}"`);

  try {
    clientLog("fetch:sending", WORKER_URL);
    const response = await fetch(WORKER_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    clientLog("fetch:response received", `status ${response.status}`);

    if (!response.ok) {
      // Backend returns JSON error bodies on failure, not a PDF.
      let message = `Request failed (${response.status})`;
      let backendLog = null;
      try {
        const errBody = await response.json();
        message = errBody.error || message;
        if (errBody.details) message += `: ${errBody.details}`;
        backendLog = errBody.debugLog || null;
      } catch (_) {
        // response wasn't JSON either; fall back to generic message
      }
      clientLog("error", message);
      printDebugTrace(clientEvents, backendLog, requestId);
      document.getElementById("warnings").innerHTML = "";
      status.textContent = message;
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
    const filename = `${orgName}_grant_draft.pdf`;

    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);

    clientLog("download:triggered", filename);
    printDebugTrace(clientEvents, backendLog, requestId);

    status.textContent = "PDF downloaded. Review the compliance checklist section before submitting anywhere. (Full request trace logged to the browser console.)";
  } catch (err) {
    clientLog("fetch:failed", String(err));
    printDebugTrace(clientEvents, null, requestId);
    status.textContent = "Failed to reach the server: " + err;
  }
}
