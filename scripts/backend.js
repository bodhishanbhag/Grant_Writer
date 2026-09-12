/**
 * AI Grant Writer — Cloudflare Worker backend
 * -----------------------------------------------------------------
 * SINGLE FILE, NO DEPENDENCIES. Paste this whole file into the
 * Cloudflare dashboard's Worker code editor and deploy — no npm,
 * no wrangler, no build step required. PDF generation is written
 * by hand below (no pdf-lib or any other library), because the
 * dashboard editor can't bundle npm packages.
 *
 * Routes:
 *   POST /chat   -> { assistantMessage, payload, missingRequired }
 *   POST /draft  -> { draft: {...} }  JSON narrative only (debugging)
 *   POST /pdf    -> application/pdf   full assembled grant application
 *
 * Input: JSON body matching SCHEMA.md (organization / project /
 * narrative / budget / additionalNotes). Every field is optional.
 *
 * Design principle: factual fields (org name, EIN, dollar amounts,
 * dates, contact info) are NEVER passed through the LLM for
 * rewriting — they're copied verbatim from the input into the PDF.
 * Only the narrative/prose sections are LLM-generated, and only from
 * notes the user actually provided.
 *
 * Secret required (Settings -> Variables and Secrets -> Add variable,
 * type "Secret"):
 *   OPENAI_API_KEY
 * Optional plain variables:
 *   OPENAI_MODEL     - defaults to "gpt-4o" (used for narrative generation)
 *   CHAT_MODEL       - defaults to OPENAI_MODEL/gpt-4o (used for Grant chat)
 *   SEARCH_MODEL     - defaults to "gpt-4.1-mini" (used ONLY for the RFA
 *                       web search fallback -- must be a model OpenAI's
 *                       Responses API actually supports the web_search
 *                       tool for; gpt-4o is NOT on that list as of this
 *                       writing. gpt-4.1-mini is the cheap/fast choice;
 *                       gpt-5.5 is more thorough but a reasoning model
 *                       and meaningfully more expensive per call)
 *   ALLOWED_ORIGIN   - defaults to "*"
 *
 * RFA GROUNDING (important limitation, read this):
 * This worker does NOT try to guess which real grant program the
 * applicant is targeting from a funding-source name. Guessing and
 * then presenting invented "requirements" as real would be worse
 * than no formatting guidance at all for a government submission.
 * Instead, if the caller provides `project.rfaUrl` (a link to the
 * actual RFA/guidelines page) and/or `project.rfaText` (pasted
 * excerpt of the actual rules), this worker fetches/uses that TEXT
 * as the only source of truth for funder-specific requirements, and
 * says so explicitly in the output. No URL/text provided -> the
 * compliance checklist stays generic and says so, rather than
 * inventing specifics.
 */

const NARRATIVE_SECTIONS = [
  { key: "executiveSummary", title: "Executive Summary" },
  { key: "statementOfNeed", title: "Statement of Need" },
  { key: "projectDescription", title: "Project Description" },
  { key: "goalsAndObjectives", title: "Goals and Objectives" },
  { key: "methodology", title: "Methodology / Work Plan" },
  { key: "evaluationPlan", title: "Evaluation Plan" },
  { key: "sustainabilityPlan", title: "Sustainability Plan" },
  { key: "organizationalCapacity", title: "Organizational Capacity" },
  { key: "budgetNarrative", title: "Budget Narrative" },
];

const SYSTEM_PROMPT = `You are an expert grant writer assisting under-resourced organizations in Washington State — including Tribal nations and small community nonprofits — who cannot afford professional grant writers.

You will receive rough notes from the applicant, organized by section, and possibly an excerpt of the ACTUAL target funder's RFA/guidelines text. Expand each section's notes into polished, persuasive, factual grant-application prose.

Hard rules:

1. GROUNDING: Only use facts, numbers, names, and claims that were actually provided in the notes. Never invent statistics, past outcomes, staff names, partner organizations, or dates. If a section's notes are empty or too thin to write real content, set that section's value to the literal string "[INSUFFICIENT INFORMATION PROVIDED - applicant should add notes on: <what's missing>]" instead of fabricating filler.

2. RFA GROUNDING: If real RFA/guidelines text is provided below (marked "OFFICIAL RFA TEXT"), that means text WAS provided -- you MUST NOT use the "no official RFA/guidelines text was provided" fallback string in that case, even if the provided text seems thin, partial, or low-detail. Treat whatever text is there as the ONLY authoritative source for that funder's specific requirements. Quote or closely paraphrase whatever concrete requirements it actually contains in "fundingRequirementsSummary" and in "complianceChecklist". If the provided text is present but does not contain much concrete detail, say exactly that ("the retrieved text is limited and mainly confirms X; it does not specify Y -- verify Y directly with the funder") rather than falling back to the "no text was provided" string, which would be factually false when a block was provided. Do not supplement it with outside assumptions about what this funder "probably" requires. Only use the literal fallback string "No official RFA/guidelines text was provided for this submission — the requirements below are generic and MUST be replaced with the actual funder's requirements before submission." when the OFFICIAL RFA TEXT section is completely absent from this prompt. Use this exact fundingRequirementsSummary fallback string verbatim in that case -- do not blend it with the different "[INSUFFICIENT INFORMATION PROVIDED...]" pattern used for the narrative sections below; that pattern is for narrative fields only, never for fundingRequirementsSummary.

3. COMPLIANCE HUMILITY: Some Washington grants (particularly those tied to the HEAL Act, RCW 70A.02) carry specific legal requirements - environmental justice assessments, Tribal consultation documentation, overburdened-community criteria, etc. Unless the OFFICIAL RFA TEXT explicitly confirms whether this applies, never assert compliance either way — instead add a checklist item asking the applicant to confirm it against their specific funder.

4. VOICE: Persuasive but factual grant-writing register. No hype, no unverifiable superlatives.

5. OUTPUT FORMAT: Respond with ONLY a JSON object, no markdown fences, no preamble, matching exactly this shape:
{
  "fundingRequirementsSummary": "string",
  "executiveSummary": "string",
  "statementOfNeed": "string",
  "projectDescription": "string",
  "goalsAndObjectives": "string",
  "methodology": "string",
  "evaluationPlan": "string",
  "sustainabilityPlan": "string",
  "organizationalCapacity": "string",
  "budgetNarrative": "string",
  "complianceChecklist": ["string", "string", ...]
}`;

const CHAT_SYSTEM_PROMPT = `You are Grant, a friendly gnome guide inside a grant-writing website.

Your job is to have a natural conversation with the applicant, ask useful follow-up questions, and continuously extract the information needed to fill a grant application.

You will receive:
1. The conversation so far.
2. The current structured payload.
3. Whether the user clicked "I'm done explaining."

Hard rules:
- Do not invent factual details. Only put information into the payload if the applicant clearly provided it.
- You may lightly organize or summarize narrative notes, but keep the applicant's facts intact.
- Ask one or two focused questions at a time unless the user is done explaining.
- If the user is done explaining, stop asking broad project questions and tell them which concrete required details still need to be filled in.
- Stay in character as Grant: warm, concise, practical, and encouraging. No markdown.

Return ONLY a JSON object with this exact shape:
{
  "assistantMessage": "string",
  "payload": {
    "organization": {
      "name": "string",
      "type": "string",
      "address": "string",
      "ein": "string",
      "contactName": "string",
      "contactTitle": "string",
      "contactEmail": "string",
      "contactPhone": "string"
    },
    "project": {
      "title": "string",
      "fundingSource": "string",
      "requestedAmount": "string",
      "periodStart": "string",
      "periodEnd": "string",
      "rfaUrl": "string",
      "rfaText": "string"
    },
    "narrative": {
      "statementOfNeed": "string",
      "projectDescription": "string",
      "goalsAndObjectives": "string",
      "targetPopulation": "string",
      "methodology": "string",
      "evaluationPlan": "string",
      "sustainabilityPlan": "string",
      "organizationalCapacity": "string"
    },
    "budget": {
      "totalProjectCost": "string",
      "budgetNarrative": "string"
    },
    "additionalNotes": "string"
  }
}`;

const REQUIRED_FIELD_DEFS = [
  { path: "organization.name", label: "Organization / Tribe Name" },
  { path: "organization.type", label: "Organization Type" },
  { path: "organization.contactName", label: "Contact Name" },
  { path: "organization.contactEmail", label: "Contact Email" },
  { path: "project.title", label: "Project Title" },
  { path: "project.requestedAmount", label: "Requested Amount" },
  { path: "project.periodEnd", label: "Project Period End" },
  { path: "narrative.statementOfNeed", label: "Statement of Need" },
  { path: "narrative.projectDescription", label: "Project Description" },
  { path: "narrative.goalsAndObjectives", label: "Goals and Objectives" },
  { path: "narrative.methodology", label: "Methodology" },
  { path: "budget.totalProjectCost", label: "Total Project Cost" },
];

function corsHeaders(env) {
  return {
    "Access-Control-Allow-Origin": env.ALLOWED_ORIGIN || "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };
}

function jsonResponse(body, status, env) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders(env) },
  });
}

function safe(val, fallback = "[Not provided]") {
  return val && String(val).trim() ? String(val).trim() : fallback;
}

/**
 * Lightweight structured logger. Every entry is also console.log'd
 * (visible via `wrangler tail` server-side) AND collected so it can be
 * shipped back to the browser -- as a response header for the /pdf
 * route (binary body can't carry JSON), and inline in the JSON body
 * for /draft and error responses. The frontend prints these to the
 * browser console (see scripts/index.js) so both sides of a request
 * are debuggable from one place without needing server log access.
 */
function createLogger() {
  const start = Date.now();
  const entries = [];
  return {
    log(step, detail) {
      const t = Date.now() - start;
      entries.push({ t, step, detail: detail === undefined ? null : String(detail) });
      console.log(`[grant-writer +${t}ms] ${step}${detail ? ": " + detail : ""}`);
    },
    entries() {
      return entries;
    },
    toHeaderValue() {
      try {
        return encodeURIComponent(JSON.stringify(entries));
      } catch (e) {
        return "";
      }
    },
  };
}

/**
 * Best-effort HTML -> plain text. No DOM parser is available in a
 * dependency-free Worker, so this is regex-based: strip script/style
 * blocks, strip remaining tags, decode a handful of common entities,
 * collapse whitespace. Good enough to hand a government RFA page's
 * text content to the model — not a general-purpose HTML parser.
 */
function htmlToText(html) {
  return String(html || "")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|h[1-6]|tr)>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s*\n+/g, "\n\n")
    .trim();
}

const MAX_RFA_CHARS = 12000; // keep prompt size sane

/**
 * Fetches project.rfaUrl (if provided) and combines it with any
 * pasted project.rfaText. Never throws — a fetch failure just means
 * we proceed without that source, with a note explaining why.
 */
async function resolveRfaText(proj) {
  const parts = [];
  let fetchNote = null;

  if (proj.rfaText && String(proj.rfaText).trim()) {
    parts.push(String(proj.rfaText).trim());
  }

  if (proj.rfaUrl && String(proj.rfaUrl).trim()) {
    const url = String(proj.rfaUrl).trim();
    try {
      const res = await fetch(url, {
        headers: { "User-Agent": "Mozilla/5.0 (grant-writer-tool)" },
      });
      if (!res.ok) {
        fetchNote = `Could not fetch rfaUrl (HTTP ${res.status}). Proceeding without it.`;
      } else {
        const contentType = res.headers.get("content-type") || "";
        if (contentType.includes("application/pdf")) {
          fetchNote =
            "rfaUrl pointed to a PDF, which this worker cannot parse directly. Paste the relevant text into project.rfaText instead.";
        } else {
          const html = await res.text();
          const text = htmlToText(html);
          if (text) parts.push(`Source URL: ${url}\n\n${text}`);
        }
      }
    } catch (err) {
      fetchNote = `Failed to fetch rfaUrl (${String(err.message || err)}). Proceeding without it.`;
    }
  }

  let combined = parts.join("\n\n---\n\n");
  if (combined.length > MAX_RFA_CHARS) {
    combined = combined.slice(0, MAX_RFA_CHARS) + "\n\n[TRUNCATED]";
  }

  return { text: combined, fetchNote };
}

/**
 * Fallback used ONLY when the caller supplied no rfaUrl/rfaText: makes
 * a separate OpenAI call (Responses API, web_search tool) using the
 * applicant's own literal `fundingSource` text as the search query.
 *
 * Deliberately does NOT try to guess a funder from vague project
 * details -- it only runs when fundingSource is non-empty, and the
 * search prompt explicitly instructs the model to say "no exact
 * match found" rather than substituting a similar-sounding program.
 * This reduces, but does not eliminate, the risk of grounding on the
 * wrong program -- the resulting source URL(s) are surfaced in the
 * PDF so the applicant can verify before trusting any of it.
 */
async function searchForRfaGuidelines(env, fundingSource, log) {
  // gpt-4o (the default used for narrative generation) is NOT on
  // OpenAI's current supported-model list for the Responses API
  // web_search tool. gpt-5.5 is the fully-featured option but is a
  // reasoning model -- meaningfully more expensive per call, since it
  // spends tokens on hidden reasoning before writing an answer.
  // gpt-4.1-mini is also on OpenAI's supported list (with some
  // limitations: no domain filters, 128k search context) but is a
  // non-reasoning model, which is both cheaper per token AND doesn't
  // burn a hidden reasoning budget -- a much better cost fit for a
  // single "does this program exist, what does its page say" lookup.
  // Override via the SEARCH_MODEL environment variable if you want
  // gpt-5.5's more thorough multi-step search behavior back, or if
  // OpenAI's supported-model list changes.
  const model = env.SEARCH_MODEL || "gpt-4.1-mini";
  const query = String(fundingSource).trim();

  const prompt = `Search the web for the official Request for Applications (RFA), Notice of Funding Opportunity (NOFO), or grant guidelines document for this EXACT program: "${query}".

This may be a Washington State agency program or a federal program. Find the actual current official government page or document -- not a third-party aggregator or summary site.

IMPORTANT: You must actually open and read the guidelines page/document itself, then extract and include the REAL requirement text in your answer -- do not just locate a URL and say "requirements are available at this link." A URL with no extracted content is not an acceptable answer when a match exists. Quote or closely paraphrase the actual eligibility criteria, required sections, page limits, font/formatting rules, required attachments, and deadlines as they are written in the source. If the guidelines are inside a linked PDF you are unable to open, say that explicitly and still give the URL, but do not fabricate requirement details you did not actually read.

Your response MUST start with exactly one of these two markers as the very first line, nothing before it:
MATCH_FOUND
or
NO_MATCH_FOUND

If MATCH_FOUND, follow it with a blank line then:
1. The exact source URL(s).
2. The actual extracted requirement text per the IMPORTANT instruction above -- not a description that requirements exist, the requirements themselves.

Use NO_MATCH_FOUND if you cannot find an official, current, EXACT match for this specific program name -- do not describe a similar or related program as if it were a match, and do not guess. Search at most 3 times.`;

  log?.log("search:request", `model=${model} funding source = "${query}"`);

  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${env.OPENAI_API_KEY}`,
    },
    body: JSON.stringify({
      model,
      tools: [{ type: "web_search" }],
      input: prompt,
      // gpt-5.5 (reasoning model) needed >= 8192 here or risked
      // truncating before writing a final answer. gpt-4.1-mini is
      // non-reasoning -- it writes directly, no hidden reasoning
      // budget to protect -- so a smaller cap is fine and saves cost.
      // Raise this back toward 8192 if you switch SEARCH_MODEL back
      // to a reasoning model like gpt-5.5.
      max_output_tokens: 3072,
    }),
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`OpenAI web search error (${response.status}): ${errText}`);
  }

  const data = await response.json();

  if (data.status && data.status !== "completed") {
    log?.log("search:incomplete", `status=${data.status}`);
  }

  // Verify the model actually invoked the search tool rather than
  // just answering from memory -- per OpenAI's own guidance, check
  // for a web_search_call item in the output. Without this check we
  // cannot tell a genuine "nothing found" from "never actually
  // looked."
  const output = Array.isArray(data.output) ? data.output : [];
  const searchCallCount = output.filter((item) => item.type === "web_search_call").length;
  log?.log("search:tool_invocations", String(searchCallCount));

  // Prefer the convenience field; fall back to scanning output items.
  let text = data.output_text;
  if (!text) {
    text = output
      .filter((item) => item.type === "message")
      .flatMap((item) => (Array.isArray(item.content) ? item.content : []))
      .filter((c) => c.type === "output_text" || c.type === "text")
      .map((c) => c.text)
      .join("\n");
  }

  if (!text || !text.trim()) {
    throw new Error("Web search call returned no text output.");
  }

  text = text.trim();
  const firstLine = text.split("\n")[0].trim().toUpperCase();
  const modelClaimsFound =
    firstLine.includes("MATCH_FOUND") && !firstLine.includes("NO_MATCH_FOUND");
  const rest = text.split("\n").slice(1).join("\n").trim();

  if (searchCallCount === 0) {
    // The model answered without ever calling the search tool. Its
    // MATCH_FOUND/NO_MATCH_FOUND claim is not trustworthy either way
    // -- treat this the same as "not found" but say why, rather than
    // presenting an unverified/possibly hallucinated answer.
    log?.log("search:untrusted", "model produced an answer without invoking web_search");
    return {
      found: false,
      text: rest || text,
      toolInvoked: false,
    };
  }

  log?.log(
    "search:result",
    modelClaimsFound ? `match found (${rest.length} chars)` : "no exact match found"
  );

  return { found: modelClaimsFound, text: rest || text, toolInvoked: true };
}

function buildUserContent(data, rfaText, rfaSourceOrigin) {
  const n = data.narrative || {};
  const b = data.budget || {};
  let rfaBlock = "";
  if (rfaText) {
    const originLabel =
      rfaSourceOrigin === "automated-web-search"
        ? "OFFICIAL RFA TEXT (found via AUTOMATED WEB SEARCH, not verified by the applicant -- if this text does not look like a real, exact match for the stated funding source, say so in complianceChecklist rather than treating it as authoritative):"
        : "OFFICIAL RFA TEXT (provided directly by the applicant -- authoritative):";
    rfaBlock = `${originLabel}\n${rfaText}\n\n---\n\n`;
  }
  return `${rfaBlock}Applicant's rough notes, by section. Expand each into full prose per your instructions. Sections with no notes should get the "[INSUFFICIENT INFORMATION PROVIDED...]" treatment, not invented content.

STATEMENT OF NEED notes: ${safe(n.statementOfNeed, "(none provided)")}

PROJECT DESCRIPTION notes: ${safe(n.projectDescription, "(none provided)")}

GOALS AND OBJECTIVES notes: ${safe(n.goalsAndObjectives, "(none provided)")}

TARGET POPULATION notes: ${safe(n.targetPopulation, "(none provided)")}

METHODOLOGY notes: ${safe(n.methodology, "(none provided)")}

EVALUATION PLAN notes: ${safe(n.evaluationPlan, "(none provided)")}

SUSTAINABILITY PLAN notes: ${safe(n.sustainabilityPlan, "(none provided)")}

ORGANIZATIONAL CAPACITY notes: ${safe(n.organizationalCapacity, "(none provided)")}

BUDGET NARRATIVE notes: ${safe(b.budgetNarrative, "(none provided)")}
Total project cost stated by applicant: ${safe(b.totalProjectCost, "(none provided)")}

ADDITIONAL NOTES (context only, don't force these into a specific section): ${safe(data.additionalNotes, "(none)")}

For your context only (do not restate these verbatim - they'll be placed on the cover sheet separately): organization is "${safe(data.organization && data.organization.name)}", project title is "${safe(data.project && data.project.title)}", requested amount is "${safe(data.project && data.project.requestedAmount)}".

Also write a brief, factual "executiveSummary" (3-5 sentences) synthesizing the above.`;
}

async function callOpenAI(env, userContent) {
  const model = env.OPENAI_MODEL || "gpt-4o";

  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${env.OPENAI_API_KEY}`,
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: userContent },
      ],
      temperature: 0.4,
      response_format: { type: "json_object" },
    }),
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`OpenAI API error (${response.status}): ${errText}`);
  }

  const data = await response.json();
  const raw = data.choices?.[0]?.message?.content;
  if (!raw) throw new Error("OpenAI response did not contain a completion.");

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new Error("OpenAI did not return valid JSON: " + raw.slice(0, 500));
  }
  return parsed;
}

function getPath(obj, path) {
  return path.split(".").reduce((cursor, part) => {
    if (!cursor || typeof cursor !== "object") return "";
    return cursor[part];
  }, obj) || "";
}

function mergeStructuredPayload(base, update) {
  const merged = JSON.parse(JSON.stringify(base || {}));
  mergeObject(merged, update || {});
  return merged;
}

function mergeObject(target, source) {
  if (!source || typeof source !== "object") return target;
  for (const [key, value] of Object.entries(source)) {
    if (value === null || value === undefined || value === "") continue;
    if (Array.isArray(value)) {
      target[key] = value.slice();
    } else if (typeof value === "object") {
      if (!target[key] || typeof target[key] !== "object") target[key] = {};
      mergeObject(target[key], value);
    } else {
      target[key] = value;
    }
  }
  return target;
}

function missingRequiredFields(payload) {
  return REQUIRED_FIELD_DEFS.filter((field) => !String(getPath(payload, field.path) || "").trim());
}

function compactMessages(messages) {
  if (!Array.isArray(messages)) return [];
  return messages
    .filter((message) => message && (message.role === "user" || message.role === "assistant"))
    .slice(-18)
    .map((message) => ({
      role: message.role,
      content: String(message.content || "").slice(0, 4000),
    }));
}

async function callGrantChat(env, body) {
  const model = env.CHAT_MODEL || env.OPENAI_MODEL || "gpt-4o";
  const currentPayload = body.payload && typeof body.payload === "object" ? body.payload : {};
  const messages = compactMessages(body.messages);
  const finishRequested = Boolean(body.finishRequested);

  const userContent = JSON.stringify({
    finishRequested,
    currentPayload,
    missingRequiredFields: missingRequiredFields(currentPayload),
    conversation: messages,
  });

  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${env.OPENAI_API_KEY}`,
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: "system", content: CHAT_SYSTEM_PROMPT },
        { role: "user", content: userContent },
      ],
      temperature: 0.35,
      response_format: { type: "json_object" },
    }),
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`OpenAI chat error (${response.status}): ${errText}`);
  }

  const data = await response.json();
  const raw = data.choices?.[0]?.message?.content;
  if (!raw) throw new Error("OpenAI chat response did not contain a completion.");

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new Error("OpenAI chat did not return valid JSON: " + raw.slice(0, 500));
  }

  const payload = mergeStructuredPayload(currentPayload, parsed.payload || {});
  const missingRequired = missingRequiredFields(payload);
  const fallbackMessage = finishRequested && missingRequired.length
    ? `I pulled out what I could. I still need: ${missingRequired.map((field) => field.label).join(", ")}.`
    : "I updated the draft notes. Tell me anything else I should know.";

  return {
    assistantMessage: safe(parsed.assistantMessage, fallbackMessage),
    payload,
    missingRequired,
  };
}

// ============================================================
// Hand-rolled PDF writer. No dependencies. Supports plain text
// only (Helvetica / Helvetica-Bold, one size, left-aligned),
// which is all this document needs.
// ============================================================

const PAGE_WIDTH = 612; // 8.5in * 72 (US Letter)
const PAGE_HEIGHT = 792; // 11in * 72
const MARGIN = 72; // 1 inch
const BODY_SIZE = 11;
const LINE_HEIGHT = 14;

// Standard Adobe Helvetica AFM character widths (per 1000 em units),
// for ASCII 32-126. Same table used as an approximation for the
// bold variant (headings are short single lines, so the minor
// inaccuracy never causes an overflow in practice).
const HELV_WIDTHS = {
  32: 278, 33: 278, 34: 355, 35: 556, 36: 556, 37: 889, 38: 667, 39: 191,
  40: 333, 41: 333, 42: 389, 43: 584, 44: 278, 45: 333, 46: 278, 47: 278,
  48: 556, 49: 556, 50: 556, 51: 556, 52: 556, 53: 556, 54: 556, 55: 556,
  56: 556, 57: 556, 58: 278, 59: 278, 60: 584, 61: 584, 62: 584, 63: 556,
  64: 1015, 65: 667, 66: 667, 67: 722, 68: 722, 69: 667, 70: 611, 71: 778,
  72: 722, 73: 278, 74: 500, 75: 667, 76: 556, 77: 833, 78: 722, 79: 778,
  80: 667, 81: 778, 82: 722, 83: 667, 84: 611, 85: 722, 86: 667, 87: 944,
  88: 667, 89: 667, 90: 611, 91: 278, 92: 278, 93: 278, 94: 469, 95: 556,
  96: 333, 97: 556, 98: 556, 99: 500, 100: 556, 101: 556, 102: 278,
  103: 556, 104: 556, 105: 222, 106: 222, 107: 500, 108: 222, 109: 833,
  110: 556, 111: 556, 112: 556, 113: 556, 114: 333, 115: 500, 116: 278,
  117: 556, 118: 500, 119: 722, 120: 500, 121: 500, 122: 500, 123: 334,
  124: 260, 125: 334, 126: 584,
};

// Maps a handful of common "smart" Unicode punctuation characters to
// their WinAnsiEncoding byte values; anything else outside ASCII
// becomes "?" so the PDF never gets corrupted by an unrepresentable
// character.
const WINANSI_MAP = {
  "\u2014": 0x97, // em dash
  "\u2013": 0x96, // en dash
  "\u2018": 0x91, // left single quote
  "\u2019": 0x92, // right single quote
  "\u201c": 0x93, // left double quote
  "\u201d": 0x94, // right double quote
  "\u2022": 0x95, // bullet
  "\u2026": 0x85, // ellipsis
};

function toWinAnsi(str) {
  let out = "";
  for (const ch of String(str || "")) {
    const code = ch.codePointAt(0);
    if (code < 128) {
      out += ch;
    } else if (WINANSI_MAP[ch] !== undefined) {
      out += String.fromCharCode(WINANSI_MAP[ch]);
    } else {
      out += "?";
    }
  }
  return out;
}

function textWidth(text, size) {
  let total = 0;
  for (const ch of text) {
    const code = ch.charCodeAt(0);
    total += HELV_WIDTHS[code] || 556;
  }
  return (total / 1000) * size;
}

function wrapText(text, size, maxWidth) {
  // NOTE: intentionally NOT applying toWinAnsi here — that mapping
  // happens exactly once, in drawLine, right before the text is
  // stored as a draw op. Mapping here too would double-encode
  // already-mapped bytes on the next pass and corrupt them.
  const paragraphs = String(text || "").split(/\n+/);
  const lines = [];
  for (const para of paragraphs) {
    const words = para.split(/\s+/).filter(Boolean);
    let line = "";
    for (const word of words) {
      const trial = line ? `${line} ${word}` : word;
      if (textWidth(trial, size) > maxWidth && line) {
        lines.push(line);
        line = word;
      } else {
        line = trial;
      }
    }
    if (line) lines.push(line);
    lines.push(""); // blank line between paragraphs
  }
  return lines;
}

function escapePdfText(text) {
  return text.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
}

/**
 * Builds a full PDF file (as a byte array) from a simple list of
 * pages, each a list of draw ops: { text, x, y, size, bold }.
 * y is measured from the bottom of the page (PDF convention).
 */
function assemblePdfBytes(pagesOps) {
  const objects = []; // { num, body } in final object-number order
  let nextNum = 1;

  const catalogNum = nextNum++;
  const pagesNum = nextNum++;
  const fontRegNum = nextNum++;
  const fontBoldNum = nextNum++;

  const pageNums = [];
  const contentNums = [];
  const pageBodies = [];

  for (const ops of pagesOps) {
    const pageNum = nextNum++;
    const contentNum = nextNum++;
    pageNums.push(pageNum);
    contentNums.push(contentNum);

    let stream = "";
    for (const op of ops) {
      if (op.type === "line") {
        stream += `${op.width || 1} w ${op.x1.toFixed(2)} ${op.y1.toFixed(
          2
        )} m ${op.x2.toFixed(2)} ${op.y2.toFixed(2)} l S\n`;
      } else if (op.type === "rect") {
        const paintOp = op.fill ? "f" : "S";
        stream += `${op.x.toFixed(2)} ${op.y.toFixed(2)} ${op.width.toFixed(
          2
        )} ${op.height.toFixed(2)} re ${paintOp}\n`;
      } else {
        // default: text
        const font = op.bold ? "F2" : "F1";
        stream += `BT /${font} ${op.size} Tf ${op.x} ${op.y.toFixed(2)} Td (${escapePdfText(
          op.text
        )}) Tj ET\n`;
      }
    }
    pageBodies.push(stream);
  }

  objects.push({
    num: catalogNum,
    body: `<< /Type /Catalog /Pages ${pagesNum} 0 R >>`,
  });

  objects.push({
    num: pagesNum,
    body: `<< /Type /Pages /Kids [${pageNums
      .map((n) => `${n} 0 R`)
      .join(" ")}] /Count ${pageNums.length} >>`,
  });

  objects.push({
    num: fontRegNum,
    body: `<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>`,
  });

  objects.push({
    num: fontBoldNum,
    body: `<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>`,
  });

  for (let i = 0; i < pageNums.length; i++) {
    objects.push({
      num: pageNums[i],
      body: `<< /Type /Page /Parent ${pagesNum} 0 R /MediaBox [0 0 ${PAGE_WIDTH} ${PAGE_HEIGHT}] /Resources << /Font << /F1 ${fontRegNum} 0 R /F2 ${fontBoldNum} 0 R >> >> /Contents ${contentNums[i]} 0 R >>`,
    });
    const streamBody = pageBodies[i];
    objects.push({
      num: contentNums[i],
      isStream: true,
      body: streamBody,
    });
  }

  objects.sort((a, b) => a.num - b.num);

  let out = "%PDF-1.4\n";
  const offsets = {}; // objNum -> byte offset

  for (const obj of objects) {
    offsets[obj.num] = out.length;
    if (obj.isStream) {
      out += `${obj.num} 0 obj\n<< /Length ${obj.body.length} >>\nstream\n${obj.body}endstream\nendobj\n`;
    } else {
      out += `${obj.num} 0 obj\n${obj.body}\nendobj\n`;
    }
  }

  const xrefOffset = out.length;
  const totalObjects = nextNum; // object numbers 1..nextNum-1, plus free entry 0

  out += `xref\n0 ${totalObjects}\n`;
  out += `0000000000 65535 f \n`;
  for (let i = 1; i < totalObjects; i++) {
    const offset = offsets[i];
    out += `${String(offset).padStart(10, "0")} 00000 n \n`;
  }

  out += `trailer\n<< /Size ${totalObjects} /Root ${catalogNum} 0 R >>\nstartxref\n${xrefOffset}\n%%EOF`;

  // Every character used above is guaranteed < 256 (ASCII PDF syntax
  // plus WinAnsi-mapped text), so a direct charCode -> byte map is safe.
  const bytes = new Uint8Array(out.length);
  for (let i = 0; i < out.length; i++) {
    bytes[i] = out.charCodeAt(i) & 0xff;
  }
  return bytes;
}

function buildPdf(data, narrative) {
  const org = data.organization || {};
  const proj = data.project || {};
  const maxWidth = PAGE_WIDTH - MARGIN * 2;

  const pagesOps = [];
  let currentOps = [];
  let y = PAGE_HEIGHT - MARGIN;

  function newPage() {
    if (currentOps.length) pagesOps.push(currentOps);
    currentOps = [];
    y = PAGE_HEIGHT - MARGIN;
  }

  function ensureSpace(needed) {
    if (y - needed < MARGIN) newPage();
  }

  function drawLine(text, opts = {}) {
    const { size = BODY_SIZE, bold = false, gap = LINE_HEIGHT, indent = 0 } = opts;
    ensureSpace(gap);
    if (text) {
      currentOps.push({ text: toWinAnsi(text), x: MARGIN + indent, y, size, bold });
    }
    y -= gap;
  }

  function drawHeading(text, opts = {}) {
    const { size = 14 } = opts;
    ensureSpace(LINE_HEIGHT * 2);
    y -= 6;
    drawLine(text, { size, bold: true, gap: LINE_HEIGHT + 4 });
  }

  // size lets a caller shrink/enlarge a specific block (e.g. fine print,
  // or a de-emphasized note) without affecting the rest of the document.
  function drawParagraphBlock(text, opts = {}) {
    const { size = BODY_SIZE, indent = 0 } = opts;
    const lines = wrapText(text, size, maxWidth - indent);
    for (const line of lines) drawLine(line, { size, indent });
  }

  // Adds vertical whitespace without drawing anything -- use this to
  // open up breathing room around a box, before a signature block, etc.
  function drawSpacer(amount) {
    ensureSpace(amount);
    y -= amount;
  }

  // A plain horizontal rule, e.g. to separate a section visually.
  function drawHRule(opts = {}) {
    const { widthPts = maxWidth, indent = 0, lineWidth = 1 } = opts;
    ensureSpace(10);
    currentOps.push({
      type: "line",
      x1: MARGIN + indent,
      y1: y,
      x2: MARGIN + indent + widthPts,
      y2: y,
      width: lineWidth,
    });
    y -= 10;
  }

  // An empty bordered box -- e.g. for an official-use-only stamp area,
  // a photo/attachment placeholder, or to visually frame a section.
  function drawBox(heightPts, opts = {}) {
    const { widthPts = maxWidth, indent = 0 } = opts;
    ensureSpace(heightPts + 6);
    currentOps.push({
      type: "rect",
      x: MARGIN + indent,
      y: y - heightPts,
      width: widthPts,
      height: heightPts,
    });
    y -= heightPts + 6;
  }

  // A single "____________  Label" signature line: draws the blank
  // line, then the label beneath it, left-aligned at the given indent.
  function drawSignatureLine(label, opts = {}) {
    const { widthPts = 220, indent = 0 } = opts;
    ensureSpace(34);
    currentOps.push({
      type: "line",
      x1: MARGIN + indent,
      y1: y,
      x2: MARGIN + indent + widthPts,
      y2: y,
      width: 1,
    });
    y -= 12;
    drawLine(label, { size: 9, indent, gap: 20 });
  }

  // Two signature lines side by side (e.g. Signature + Date), followed
  // by a Printed Name / Title line beneath. This is the concrete
  // example of the box/line/spacer primitives above -- add more of
  // these anywhere in the document by calling drawSignatureLine /
  // drawHRule / drawBox / drawSpacer directly.
  function drawSignatureBlock(roleLabel) {
    ensureSpace(90); // guarantee the whole block stays on one page
    drawSpacer(10);
    drawLine(roleLabel, { size: 11, bold: true, gap: 20 });
    drawSignatureLine("Signature", { widthPts: 220 });
    y += 32; // pull back up so the Date line sits beside, not below
    drawSignatureLine("Date", { widthPts: 120, indent: 260 });
    drawSignatureLine("Printed Name and Title", { widthPts: 320 });
  }

  // ---- Cover sheet ----
  drawLine("DRAFT GRANT APPLICATION", { size: 18, bold: true, gap: 26 });

  drawHeading("Applicant");
  drawParagraphBlock(`Organization: ${safe(org.name)}`);
  drawParagraphBlock(`Organization Type: ${safe(org.type)}`);
  drawParagraphBlock(`Address: ${safe(org.address)}`);
  drawParagraphBlock(`EIN / Tax ID: ${safe(org.ein)}`);
  drawParagraphBlock(
    `Contact: ${safe(org.contactName)}${org.contactTitle ? ", " + org.contactTitle : ""}`
  );
  drawParagraphBlock(`Email: ${safe(org.contactEmail)}    Phone: ${safe(org.contactPhone)}`);

  drawHeading("Project");
  drawParagraphBlock(`Project Title: ${safe(proj.title)}`);
  drawParagraphBlock(`Funding Source / Program: ${safe(proj.fundingSource)}`);
  drawParagraphBlock(`Requested Amount: ${safe(proj.requestedAmount)}`);
  drawParagraphBlock(`Project Period: ${safe(proj.periodStart)} to ${safe(proj.periodEnd)}`);
  drawParagraphBlock(`Total Project Cost: ${safe((data.budget || {}).totalProjectCost)}`);

  // ---- Narrative sections ----
  // NOTE: no "AI-drafted" / "verbatim" labels here on purpose. This
  // PDF is meant to be the actual draft the applicant edits and
  // submits to the funder -- it should read like a real application,
  // not like a report about how a tool generated it. Anything about
  // sourcing, confidence, or what needs review lives on the website
  // (see the X-Grant-Warnings header below), not in the document
  // itself.
  for (const section of NARRATIVE_SECTIONS) {
    newPage();
    drawHeading(section.title);
    drawParagraphBlock(narrative[section.key] || "[No content generated]");
  }

  // ---- Certification / signatures ----
  // (Compliance checklist / funding-requirements warnings intentionally
  // NOT included here -- that's tool-generated meta-commentary about
  // this draft, not application content, and is surfaced on the
  // website instead. This page IS real content: most funders actually
  // require a signed certification page in the submitted package.)
  newPage();
  drawHeading("Certification and Authorized Signatures");
  drawParagraphBlock(
    "By signing below, the undersigned certifies that the information in this application is true and accurate to the best of their knowledge, and that they are authorized to submit this application on behalf of the organization named above."
  );
  drawHRule({ widthPts: maxWidth });
  drawSignatureBlock("Authorized Representative");
  drawSignatureBlock("Preparer (if different from above)");
  drawSpacer(16);
  drawLine("Official Use Only", { size: 9, bold: true, gap: 14 });
  drawBox(70, { widthPts: maxWidth });

  if (currentOps.length) pagesOps.push(currentOps);

  // ---- Page numbers (added after page count is known) ----
  const total = pagesOps.length;
  pagesOps.forEach((ops, i) => {
    ops.push({
      text: `Page ${i + 1} of ${total}`,
      x: PAGE_WIDTH - MARGIN - 80,
      y: MARGIN / 2,
      size: 9,
      bold: false,
    });
  });

  return assemblePdfBytes(pagesOps);
}

// ---------- Router ----------

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders(env) });
    }
    if (request.method !== "POST") {
      return jsonResponse({ error: "Method not allowed. Use POST." }, 405, env);
    }
    if (!env.OPENAI_API_KEY) {
      return jsonResponse(
        { error: "Server misconfigured: OPENAI_API_KEY secret is not set." },
        500,
        env
      );
    }

    const log = createLogger();
    const url = new URL(request.url);
    log.log("request:received", `${request.method} ${url.pathname}`);

    let body;
    try {
      body = await request.json();
    } catch (e) {
      return jsonResponse({ error: "Request body must be valid JSON.", debugLog: log.entries() }, 400, env);
    }
    if (!body || typeof body !== "object") {
      return jsonResponse(
        { error: "Request body must be a JSON object matching SCHEMA.md.", debugLog: log.entries() },
        400,
        env
      );
    }
    log.log("request:body parsed", `org="${(body.organization || {}).name || ""}"`);

    if (url.pathname === "/chat") {
      log.log("chat:requesting");
      try {
        const chat = await callGrantChat(env, body);
        log.log("chat:received", `${chat.missingRequired.length} required fields missing`);
        return jsonResponse({ ...chat, debugLog: log.entries() }, 200, env);
      } catch (err) {
        console.error(err);
        log.log("chat:failed", String(err.message || err));
        return jsonResponse(
          {
            error: "Failed to continue Grant's conversation.",
            details: String(err.message || err),
            debugLog: log.entries(),
          },
          502,
          env
        );
      }
    }

    log.log("rfa:resolving", "checking rfaUrl/rfaText");
    const { text: fetchedText, fetchNote } = await resolveRfaText(body.project || {});
    let rfaText = fetchedText;
    let rfaSourceOrigin = rfaText ? "user-provided" : null;
    let searchNote = null;
    if (fetchNote) log.log("rfa:fetch note", fetchNote);
    if (rfaSourceOrigin) log.log("rfa:resolved", "user-provided text/URL in use");

    const fundingSource = body.project && String(body.project.fundingSource || "").trim();
    if (!rfaText && fundingSource) {
      log.log("rfa:no user source", "falling back to automated web search");
      try {
        const searchResult = await searchForRfaGuidelines(env, fundingSource, log);
        if (searchResult.found) {
          rfaText = searchResult.text;
          rfaSourceOrigin = "automated-web-search";
        } else if (searchResult.toolInvoked === false) {
          searchNote = `Automated search for "${fundingSource}" did not actually invoke a web search (the model answered without searching) -- this is inconclusive, not a confirmed "no match." Provide the RFA URL or text manually for grounded requirements.`;
          log.log("rfa:search", "tool never invoked -- proceeding generic");
        } else {
          searchNote = `Automated search found no official RFA/guidelines match for "${fundingSource}". Provide the RFA URL or text manually for grounded requirements.`;
          log.log("rfa:search", "no match -- proceeding generic");
        }
      } catch (err) {
        console.error(err);
        log.log("rfa:search failed", String(err.message || err));
        searchNote = `Automated search for RFA guidelines failed: ${String(
          err.message || err
        )}`;
      }
    } else if (!rfaText) {
      log.log("rfa:no source", "no funding source stated -- nothing to search for");
    }

    log.log("narrative:requesting", rfaSourceOrigin ? `grounded (${rfaSourceOrigin})` : "generic");
    let narrative;
    try {
      narrative = await callOpenAI(env, buildUserContent(body, rfaText, rfaSourceOrigin));
      if (fetchNote) narrative._rfaFetchNote = fetchNote;
      if (searchNote) narrative._rfaFetchNote = [narrative._rfaFetchNote, searchNote]
        .filter(Boolean)
        .join(" ");
      narrative._rfaSourceOrigin = rfaSourceOrigin;
      narrative._rfaRawText = rfaText || null;
      log.log("narrative:received", Object.keys(narrative).join(","));
    } catch (err) {
      console.error(err);
      log.log("narrative:failed", String(err.message || err));
      return jsonResponse(
        {
          error: "Failed to generate grant narrative.",
          details: String(err.message || err),
          debugLog: log.entries(),
        },
        502,
        env
      );
    }

    if (url.pathname === "/draft") {
      return jsonResponse({ draft: narrative, debugLog: log.entries() }, 200, env);
    }

    try {
      log.log("pdf:assembling");
      const pdfBytes = buildPdf(body, narrative);
      log.log("pdf:assembled", `${pdfBytes.length} bytes`);
      const orgSlug = safe(body.organization && body.organization.name, "grant").replace(
        /[^a-z0-9]+/gi,
        "_"
      );

      // Everything intentionally left OUT of the submittable PDF --
      // RFA sourcing status, compliance checklist, raw retrieved text
      // -- goes here instead, for the website to display directly to
      // the applicant (not just the browser console).
      const warnings = {
        rfaSourceOrigin: narrative._rfaSourceOrigin || null,
        rfaFetchNote: narrative._rfaFetchNote || null,
        fundingRequirementsSummary: narrative.fundingRequirementsSummary || null,
        complianceChecklist: Array.isArray(narrative.complianceChecklist)
          ? narrative.complianceChecklist
          : [],
        rfaRawTextPreview: narrative._rfaRawText
          ? narrative._rfaRawText.slice(0, 2000)
          : null,
      };
      let warningsHeader = "";
      try {
        warningsHeader = encodeURIComponent(JSON.stringify(warnings));
      } catch (e) {
        log.log("warnings:encode failed", String(e.message || e));
      }

      return new Response(pdfBytes, {
        status: 200,
        headers: {
          "Content-Type": "application/pdf",
          "Content-Disposition": `attachment; filename="${orgSlug}_grant_draft.pdf"`,
          "X-Grant-Debug": log.toHeaderValue(),
          "X-Grant-Warnings": warningsHeader,
          "Access-Control-Expose-Headers": "X-Grant-Debug, X-Grant-Warnings",
          ...corsHeaders(env),
        },
      });
    } catch (err) {
      console.error(err);
      log.log("pdf:failed", String(err.message || err));
      return jsonResponse(
        { error: "Failed to assemble PDF.", details: String(err.message || err), debugLog: log.entries() },
        500,
        env
      );
    }
  },
};
