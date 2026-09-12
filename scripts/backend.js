// Cloudflare Worker backend for the grant writer. One file, no
// dependencies — paste it straight into the Worker code editor and
// deploy, no npm or build step.
//
// Routes: POST /chat (talk to Grant), POST /draft (narrative JSON,
// for debugging), POST /pdf (the real output).
//
// Facts — org name, EIN, dollar amounts, dates, contact info — never
// go through the LLM. They're copied straight from the input into
// the PDF. Only the narrative sections get generated, and only from
// notes the applicant actually gave us.
//
// Needs an OPENAI_API_KEY secret. Optional env vars: OPENAI_MODEL
// (narrative gen, default gpt-4o), CHAT_MODEL (Grant chat, falls
// back to OPENAI_MODEL), SEARCH_MODEL (RFA web-search fallback,
// default gpt-4.1-mini), ALLOWED_ORIGIN (default "*").
//
// On RFA grounding: we don't try to guess which real grant program
// someone means from a funding-source name — inventing "requirements"
// for a government submission is worse than giving none. If the
// caller gives us project.rfaUrl or project.rfaText, that's our only
// source of truth for funder-specific requirements. No source given,
// no requirements guessed — the checklist just says so.

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

// Every entry gets console.log'd and collected, so it can also be
// sent back to the browser — header on /pdf (binary body can't carry
// JSON), inline JSON body elsewhere. Lets you debug a request from
// the browser console without needing server log access.
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

// Quick HTML -> text. No DOM parser in a dependency-free Worker, so
// it's regex: strip script/style, strip tags, decode common entities,
// collapse whitespace. Fine for handing an RFA page to the model —
// not a real parser.
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

const MAX_RFA_CHARS = 12000; // keep the prompt a sane size

// Fetches project.rfaUrl (if given) and combines it with any pasted
// project.rfaText. Never throws — a failed fetch just means we go on
// without that source, with a note explaining why.
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

// Only runs when the caller gave no rfaUrl/rfaText: does a real web
// search for the funder's actual guidelines instead of guessing.
// Only fires when fundingSource is non-empty, and the prompt tells
// the model to say "no match" rather than substitute something
// similar-sounding. Doesn't eliminate the risk of grounding on the
// wrong program, but the source URLs get surfaced so the applicant
// can check.
async function searchForRfaGuidelines(env, fundingSource, log) {
  // gpt-4o isn't on OpenAI's supported list for the Responses API's
  // web_search tool. gpt-4.1-mini is: cheap, non-reasoning, good fit
  // for a "does this program exist" lookup. Set SEARCH_MODEL if you
  // want gpt-5.5's more thorough (and pricier) search instead.
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
      // Reasoning models can get cut off before writing an answer if
      // this is too low. Bump it back toward 8192 if SEARCH_MODEL is
      // switched to one (e.g. gpt-5.5).
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

  // Check the model actually called web_search rather than just
  // answering from memory — otherwise we can't tell "found nothing"
  // from "never looked."
  const output = Array.isArray(data.output) ? data.output : [];
  const searchCallCount = output.filter((item) => item.type === "web_search_call").length;
  log?.log("search:tool_invocations", String(searchCallCount));

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
    // Model skipped the tool entirely, so its match/no-match claim
    // isn't trustworthy either way. Treat as "not found" and say why.
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

// ---- Hand-rolled PDF writer ----
// No dependencies, plain text only (Helvetica / Helvetica-Bold, one
// size, left-aligned) — that's all this document needs.

const PAGE_WIDTH = 612; // US Letter, points (72pt/in)
const PAGE_HEIGHT = 792;
const MARGIN = 72;
const BODY_SIZE = 11;
const LINE_HEIGHT = 14;

// Adobe's standard Helvetica AFM widths (per 1000 em, ASCII 32-126),
// reused as an approximation for bold too — headings are short
// single lines, so it never actually causes an overflow.
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

// Common "smart" punctuation mapped to WinAnsi bytes; anything else
// outside ASCII becomes "?" instead of corrupting the PDF.
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
  // toWinAnsi happens once, in drawLine, right before the text
  // becomes a draw op — doing it here too would double-encode and
  // corrupt already-mapped bytes.
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

// Turns a list of pages (each a list of draw ops — text, line, or
// rect) into actual PDF bytes. y is measured from the bottom, PDF-style.
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
        // anything else is text
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

  // Every char here is under 256 (ASCII PDF syntax + WinAnsi-mapped
  // text), so charCode -> byte is safe.
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

  // size lets you shrink/grow just this one block, e.g. fine print.
  function drawParagraphBlock(text, opts = {}) {
    const { size = BODY_SIZE, indent = 0 } = opts;
    const lines = wrapText(text, size, maxWidth - indent);
    for (const line of lines) drawLine(line, { size, indent });
  }

  // Just vertical breathing room, doesn't draw anything.
  function drawSpacer(amount) {
    ensureSpace(amount);
    y -= amount;
  }

  // A plain horizontal rule to separate sections.
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

  // Empty bordered box — stamp area, attachment placeholder, whatever.
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

  // A single "____________  Label" line.
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

  // Signature + Date side by side, then a Printed Name line beneath.
  function drawSignatureBlock(roleLabel) {
    ensureSpace(90); // keep the whole block on one page
    drawSpacer(10);
    drawLine(roleLabel, { size: 11, bold: true, gap: 20 });
    drawSignatureLine("Signature", { widthPts: 220 });
    y += 32; // back up so Date sits beside Signature, not below it
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
  // No "AI-drafted" labels here on purpose — this should read like a
  // real application, not a report about how a tool made it.
  // Sourcing/confidence notes live on the website instead
  // (X-Grant-Warnings header below).
  for (const section of NARRATIVE_SECTIONS) {
    newPage();
    drawHeading(section.title);
    drawParagraphBlock(narrative[section.key] || "[No content generated]");
  }

  // ---- Certification / signatures ----
  // Compliance checklist stays off this page too — that's commentary
  // about the draft, not application content. This page is real
  // though: most funders want an actual signed certification.
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

      // Everything left out of the submittable PDF — RFA sourcing
      // status, checklist, raw retrieved text — goes here instead,
      // for the website to show the applicant directly.
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
