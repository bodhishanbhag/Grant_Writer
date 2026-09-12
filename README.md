# Grant_Writer
An AI-assisted grant application generator built for Tribal nations, Native-led organizations, and Native-serving nonprofits in the Pacific Northwest. You talk through your project in a chat interface with "Grant," an AI guide, and it turns the conversation into a formatted PDF grant application draft.

The site also ships with a curated, re-verifiable database of Indigenous-specific funding opportunities in the Seattle / PNW region.

Why this instead of just using ChatGPT
A guided intake flow, not a blank prompt box. Grant asks follow-up questions, tracks which required fields (org info, project details, budget, narrative sections) are still missing, and visually shows progress as you fill them in — no prompt engineering required.
Facts are never left to the model. Organization name, EIN, dollar amounts, dates, and contact info are copied verbatim from what you typed into the PDF. Only the narrative/prose sections (statement of need, methodology, etc.) are LLM-generated, and only from notes you actually provided — this avoids the model quietly inventing or altering factual details.
No silent hallucination of funder requirements. If you give the app a real RFA link or pasted guidelines text, it grounds the compliance checklist in that actual text. If you don't, it says so explicitly rather than inventing plausible-sounding rules for a funder it doesn't actually know.
A maintained PNW Indigenous funders database is built in, so users can identify real local funding partners instead of starting from zero.
Project structure
index.html                          Chat UI — talk to Grant, watch required-field progress
Indigenous PNW Grants Database.html Browsable database of PNW Indigenous-specific funders
indigenous-pnw-grants.json          Data source for the funders database
scripts/index.js                    Frontend logic: chat state, field tracking, PDF download
scripts/backend.js                  Cloudflare Worker backend (chat, draft, and PDF generation)
styles/                             Page styling
images/                             Guide character art/video, icons
How it works
Frontend (index.html + scripts/index.js) is a static site — no build step. It holds the conversation state (persisted to localStorage), tracks which required fields are filled, and renders a form for any starred fields still missing once you say you're done.
Backend (scripts/backend.js) is a single-file Cloudflare Worker with no external dependencies, meant to be pasted directly into the Cloudflare dashboard's Worker editor. It exposes:
POST /chat — sends the conversation to the model, extracts structured project details, and returns the assistant's reply plus any missing required fields.
POST /draft — returns the generated narrative JSON only (for debugging).
POST /pdf — assembles the full application, including a hand-written PDF generator (no pdf-lib or similar, since the dashboard editor can't bundle npm packages), and returns the finished PDF.
If a real RFA URL or pasted guidelines text is supplied, the backend fetches/uses that text as the sole source of truth for funder-specific requirements in the compliance checklist. Otherwise the checklist stays generic and says so.
Setup

The frontend is static — open index.html or serve the repo root with any static file server.

The backend has no local dev/build step; it's designed to be pasted straight into a Cloudflare Worker. In the Cloudflare dashboard:

Create a new Worker and paste in the contents of scripts/backend.js.
Add a Secret environment variable:
OPENAI_API_KEY — required.
Optional plain environment variables:
OPENAI_MODEL — defaults to gpt-4o. Used for narrative generation.
CHAT_MODEL — defaults to OPENAI_MODEL/gpt-4o. Used for the Grant chat.
SEARCH_MODEL — defaults to gpt-4.1-mini. Used only for the RFA web-search fallback; must be a model that supports OpenAI's Responses API web_search tool.
ALLOWED_ORIGIN — defaults to *.
Deploy, then point WORKER_BASE_URL at the top of scripts/index.js to your Worker's URL.
Data

indigenous-pnw-grants.json is a living reference of funders prioritizing Tribal nations and Native-led/Native-serving organizations in and around Seattle and the wider Pacific Northwest. Each entry has a lastVerified date and sourceNotes. Funder priorities, award ranges, and open/closed status change often — re-verify any entry whose lastVerified date is more than ~2 months old against its source URL before relying on it in a real submission.

Important: Grant application drafts produced by this tool are starting points, not final, submission-ready documents. Always verify funder requirements against the funder's own current guidelines before submitting anywhere.

Contact
Angela — azhou@eastsideprep.org
Bodhi — bshanbhag@eastsideprep.org
Saanvi — ssingh@eastsideprep.org
Zimo — zwang@eastsideprep.org
