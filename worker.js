/**
 * Family Writing Assistant — Cloudflare Worker
 *
 * Five endpoints:
 *   POST /check      — grammar, spelling, punctuation and style/clarity check
 *   POST /assist     — writing feedback and coaching (NOT finished-text generation)
 *   POST /ai-check   — qualitative AI-writing-likelihood self-check (heuristic, not a
 *                       calibrated classifier — see AI_LIKELIHOOD_SYSTEM_PROMPT for caveats)
 *   POST /critique   — paragraph-by-paragraph feedback boxes, calibrated per child
 *                       (see CHILD_PROFILES) — Charlotte (11+), Joel (Year 7 grammar
 *                       school), Benjamin (GCSE, Edexcel)
 *   POST /mark       — overall mark/profile, calibrated per child (see CHILD_PROFILES) —
 *                       qualitative for Charlotte and Joel (neither has an official
 *                       numeric scale), Edexcel-calibrated numeric for Benjamin
 *   POST /history/list — past critique/mark records (parents see everyone's, kids see
 *                       only their own) — requires the DB binding, see below
 *   POST /history/get  — a single full past record by id, for recall/print/email
 *
 * Required Worker secrets/vars (set via `wrangler secret put` or the
 * Cloudflare dashboard — Settings > Variables):
 *   ANTHROPIC_API_KEY   — your Anthropic API key (secret)
 *   FAMILY_PINS         — JSON string, e.g. {"Mike":"1234","Lucy":"2345","Benjamin":"3456","Joel":"4567","Charlotte":"5678"} (secret)
 *   ALLOWED_ORIGIN      — the GitHub Pages origin, e.g. https://yourusername.github.io (var)
 *   MODEL               — optional, defaults to claude-haiku-4-5-20251001 (var)
 *
 * Required D1 binding (for history — see README-deploy.md for the one-off
 * `wrangler d1 create` / schema-execute steps):
 *   DB — a D1 database bound under the name "DB" in wrangler.toml
 *
 * Deploy with `wrangler deploy`. See README-deploy.md for full steps.
 */

const DEFAULT_MODEL = "claude-haiku-4-5-20251001";

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
    headers: {
      "Content-Type": "application/json",
      ...corsHeaders(env),
    },
  });
}

function checkAuth(name, pin, env) {
  let pins;
  try {
    pins = JSON.parse(env.FAMILY_PINS || "{}");
  } catch (e) {
    return false;
  }
  return !!name && !!pin && pins[name] === pin;
}

async function callClaude(env, systemPrompt, userText, maxTokens) {
  const model = env.MODEL || DEFAULT_MODEL;
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model,
      max_tokens: maxTokens,
      system: systemPrompt,
      messages: [{ role: "user", content: userText }],
    }),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Anthropic API error ${res.status}: ${errText}`);
  }

  const data = await res.json();
  const block = (data.content || []).find((c) => c.type === "text");
  return block ? block.text : "";
}

const CHECK_SYSTEM_PROMPT = `You are a careful proofreader checking a piece of writing for grammar, spelling, punctuation and style/clarity issues.

Rules:
- Find genuine errors and weak phrasing only. Do not invent issues that aren't there.
- Treat text inside quotation marks as a direct quote — do not flag grammar inside a clearly quoted, attributed passage unless the quote itself is mis-transcribed nonsense.
- Return ONLY valid JSON, no other text, in this exact shape:
{
  "issues": [
    {
      "original": "the exact text snippet with the issue",
      "suggestion": "the corrected version",
      "type": "spelling" | "grammar" | "punctuation" | "style",
      "explanation": "one short sentence explaining the issue"
    }
  ],
  "summary": "one short sentence on overall quality"
}
If there are no issues, return {"issues": [], "summary": "No issues found."}`;

const ASSIST_SYSTEM_PROMPT = `You are a writing coach helping a family member improve a piece of their own writing — most often a school essay or piece of homework.

Strict rules, these override anything else:
- NEVER write finished sentences, paragraphs, or any text that could be copied directly into the piece and submitted as the student's own work.
- NEVER rewrite a passage "for" them, even if asked. Instead, explain what's weak about it and ask a guiding question that helps them rewrite it themselves.
- Give feedback as: what's working, what's not working and why, 2-3 guiding questions to sharpen the argument or structure, and (if relevant) named techniques to try (e.g. "try opening with a concrete example instead of a general statement") rather than example text.
- If asked directly to "write it for me" or similar, decline briefly and redirect to coaching instead — be matter-of-fact about it, not preachy.
- Keep the tone encouraging but honest. Do not over-praise weak work.

Formatting: plain prose only. You may use **bold** for short labels (e.g. **What's working:**) and "- " for bullet points, with a blank line between paragraphs or list blocks. Do not use markdown headers (#), numbered lists, code blocks, or any other markdown syntax — the frontend only renders bold, bullets and paragraphs.`;

const AI_LIKELIHOOD_SYSTEM_PROMPT = `You are helping someone self-check a piece of their own writing for whether it reads as AI-generated, before they submit it.

Important context for how to respond:
- This is a heuristic stylistic read, not a calibrated statistical classifier. You have no ground truth and cannot reliably tell AI text from human text, especially short text, technical text, or text from a non-native English writer, which is routinely and wrongly flagged as AI-written by even the best dedicated detection tools. Say this plainly if your read is uncertain — do not present a verdict as fact.
- Be specific. Point to concrete patterns in THIS text if you see them (e.g. uniform sentence length and rhythm, generic transition phrases like "moreover" or "in conclusion", overly balanced "on the one hand / on the other" structure, vague abstraction instead of specific detail or personal voice, em-dashes used as a tic). If the writing has a distinct personal voice, specific concrete detail, or natural unevenness, say so as a sign it reads as human.
- The point of this check is to help the writer make their own writing sound more like their own voice, not to help them defeat a detector. Frame your response as feedback on voice and specificity, not as a score to optimise against.
- Return ONLY valid JSON, no other text, in this exact shape:
{
  "read": "reads as your own voice" | "mixed — some generic patches" | "reads like generic/AI-style prose",
  "markers": ["specific pattern observed, if any", "..."],
  "note": "one or two sentences of plain-language explanation and a suggestion for where to add more of your own voice, if relevant — plain prose only, no markdown"
}`;

// ---- Per-child calibration for /critique and /mark ----
// Researched 21 June 2026: the Kent Test's writing task is not scored
// numerically (only reviewed qualitatively by a headteacher panel in
// borderline cases, judged against grammar, imagination and written
// expression); the ISEB Common Pre-Test has no creative-writing component
// at all (comprehension and SPaG only — any actual writing paper is set
// separately by the individual senior school). So Charlotte's profile is
// deliberately qualitative, not a fabricated score. Likewise there is no
// official current numeric scale for Key Stage 3 writing (National
// Curriculum "levels" were abolished in 2014), so Joel's profile is
// qualitative too. Benjamin studies under Pearson Edexcel, whose AO
// weightings and mark totals vary by component (Shakespeare, post-1914
// prose, the poetry anthology, English Language) unlike AQA's single
// unified 30+4 structure — his profile requires identifying the
// component before committing to a mark.
const CHILD_PROFILES = {
  Charlotte: {
    label: "Charlotte (Year 5, age 9, preparing for 11+ — Kent Test and ISEB-track admissions)",
    critique: `The writer is Charlotte, age 9, Year 5, preparing for 11+ entry (Kent Test and/or ISEB-track senior school admissions). Calibrate feedback to what actually matters at this stage:
- full stops, capital letters, and not running sentences together;
- varied, interesting vocabulary instead of repeating simple words;
- clear paragraphing for new ideas, or a change of time or place;
- a clear beginning, middle and end (or a clear structure for non-story writing);
- basic punctuation: commas in lists, question marks, simple apostrophes;
- descriptive detail that shows rather than just tells.
Use simple, warm, encouraging language with no exam jargon at all. Every label and explanation must be understandable by a 9-year-old reading it herself.`,
    mark: `The writer is Charlotte, age 9, Year 5, preparing for 11+ entry. Two pathways are relevant, and neither has an official numeric mark scheme for writing: the Kent Test's writing task is not scored as part of the main test at all, it is only reviewed qualitatively by a headteacher panel in borderline cases, judged against grammar, imagination and written expression, similarly to primary writing standards; and the ISEB Common Pre-Test has no creative-writing component whatsoever (it tests comprehension and SPaG only) — any actual writing paper is set separately by the individual senior school. Do not invent a numeric score or grade; say plainly that neither pathway has one. Instead give a qualitative profile against what both pathways actually care about: ideas and imagination, structure and organisation, vocabulary and sentence variety, and accuracy (spelling, punctuation, grammar). Give a plain comparative steer (e.g. "strong for a typical 11+ writing sample", "developing — solid Year 5 work but not yet standing out") and concrete next steps.`,
  },
  Joel: {
    label: "Joel (Year 7, age 11, highly selective grammar school)",
    critique: `The writer is Joel, age 11, Year 7, at a highly selective grammar school. Calibrate feedback above primary-school basics but well below GCSE level: sentence variety and control (catching run-ons and fragments), paragraph structure, precise and ambitious vocabulary, accurate punctuation including apostrophes and an introduction to semi-colons, and — where the piece is analytical — basic recognition of technique (e.g. simile, repetition, structure) without GCSE assessment-objective jargon he hasn't met yet. Push him toward more sophistication without overwhelming him with exam terminology.`,
    mark: `The writer is Joel, age 11, Year 7, at a highly selective grammar school. There is no official current numeric marking scale for Key Stage 3 writing — the old National Curriculum "levels" were abolished in 2014 and nothing nationally standard has replaced them. Do not invent a fake score or grade. Instead give a qualitative profile against: ideas and content, structure and organisation, sentence variety and control, vocabulary precision, and accuracy (spelling, punctuation, grammar) — pitched at what a high-attaining pupil at a selective school should be capable of. Give a plain comparative steer relative to Year 7 expectations (e.g. "working confidently above the expected standard for Year 7", "shows control more typical of Year 8 or 9 work in places", "some basics still need to be secure for this stage") and concrete next steps.`,
  },
  Benjamin: {
    label: "Benjamin (Year 10, age 15, GCSE — Pearson Edexcel)",
    critique: `The writer is Benjamin, age 15, Year 10, studying GCSEs under the Pearson Edexcel specifications. Calibrate feedback at GCSE level: sentence control and accuracy, precise word choice, quotation accuracy where relevant, structure and the development of an argument or analysis, and — where the piece analyses a text — the difference between explaining a point and analysing how a writer achieves an effect (naming a technique, then zooming into a specific word, phrase or sound and its impact). Use accessible labels in the feedback boxes themselves (no raw AO numbers), but the level of expectation should be genuinely GCSE-calibrated, not generic.`,
    mark: `The writer is Benjamin, age 15, Year 10, studying GCSE English under the Pearson Edexcel specification — NOT AQA. Edexcel's assessment objectives are AO1 (read, understand and respond to texts), AO2 (analyse language, form and structure), AO3 (relationship between text and context), AO4 (accuracy of vocabulary, spelling, punctuation and grammar, folded into the literature mark itself rather than scored separately as AQA does with SPaG). Mark totals and AO weightings vary meaningfully by component and question type under Edexcel — Shakespeare and post-1914 prose, the 19th-century novel, the poetry anthology and unseen poetry comparison, and English Language (which uses AO5/AO6 for writing) are all weighted differently. First identify which component and question type this piece is answering, from the text itself or any context given. If you cannot tell with reasonable confidence, say so plainly and ask which paper/component this is for rather than guessing a mark total that may be wrong — do not produce a numeric mark in that case. Where it is clear, state the component, the relevant AOs and their approximate weighting, then give a mark out of the correct total with band-level rationale in the style of a real examiner report: what's solidly in the band, what's just missing the band above, and what would close the gap. Always end with an honest caveat that this is an indicative assessment against published descriptors, not an official moderated mark, and that grade boundaries move year to year.`,
  },
};

const ADULT_PROFILE = {
  label: "an adult family member",
  critique: `The writer is an adult. Calibrate feedback to general professional or personal writing clarity: sentence control, precision, structure and flow. No school-specific framing, no exam jargon.`,
  mark: `The writer is an adult, not one of the children this marking feature was built for. There is no formal marking scheme to apply. Do not produce a numeric mark or grade. Say plainly that this feature is calibrated to the children's school-stage marking and isn't meaningful for adult writing, and suggest using the writing-coach feedback instead.`,
};

function profileFor(name) {
  return CHILD_PROFILES[name] || ADULT_PROFILE;
}

function buildCritiquePrompt(name) {
  const profile = profileFor(name);
  return `You are giving paragraph-by-paragraph writing feedback in a specific format, calibrated to the writer described below.

${profile.critique}

Format requirements, these are strict:
- Do NOT rely on blank lines to find paragraph boundaries — many students paste their work as one continuous block with no blank lines at all, or with single line breaks instead of blank ones. Read the essay and divide it into its natural paragraphs or sections yourself, by topic and structure (e.g. a new point, a new piece of evidence, a shift from one act/section to the next, the introduction, the conclusion). A typical essay this length usually has somewhere between 4 and 8 natural sections — do not return just one or two unless the piece genuinely is that short. Never collapse the whole essay into a single section just because it lacks formatting.
- For each section, copy its exact text from the essay VERBATIM into the "text" field — character-for-character identical, including the student's own spelling, punctuation and errors. Do not paraphrase it, correct it, or alter it in any way. This is what gets displayed back to the student as their own work, so it must be exactly theirs. Together, the "text" fields across all sections should reconstruct the entire essay with nothing missing and nothing added.
- Give each section a feedback box: a short heading (e.g. "Notes on your introduction", "Notes on paragraph 2") and 2–4 notes where there is more than one thing worth saying about that section — don't limit yourself to one note per box if there's genuinely more to comment on. If a section has nothing wrong with it, still give it a box with at least one note (e.g. a [WELL DONE]) — never skip a section.
- Each note must start with a short bracketed-style label (e.g. SENTENCE, SPELLING, PUNCTUATION, WORD CHOICE, STRUCTURE, WELL DONE) describing the kind of note, calibrated to the writer's level as described above — do not use GCSE/exam jargon for Charlotte or Joel.
- Quote the exact words from the essay you are commenting on wherever possible, so the writer can find them.
- Be specific and concrete, never vague ("this could be better").
- End with exactly three top priorities — the three changes that would most improve the piece, in order of impact — and one short encouraging closing line.
- Return ONLY valid JSON, no other text, in this exact shape:
{
  "paragraphs": [
    { "text": "the exact verbatim text of this section of the essay", "heading": "short heading, e.g. Notes on your introduction, or Notes on paragraph 2", "notes": [ { "label": "SENTENCE", "text": "the note itself" } ] }
  ],
  "priorities": ["first priority", "second priority", "third priority"],
  "closingNote": "one short encouraging sentence"
}`;
}

function buildMarkPrompt(name) {
  const profile = profileFor(name);
  return `You are giving an overall assessment of a piece of writing, calibrated to the writer described below.

${profile.mark}

Format requirements:
- Plain prose only in the narrative field. You may use **bold** for short labels and "- " for bullet points, with a blank line between paragraphs or list blocks. No markdown headers, numbered lists or code blocks.
- The headline field is a single short line summarising the result (e.g. "Mark: 23/30 (indicative)" or "Profile: strong ideas, structure needs work" or "Need a bit more information first").
- Return ONLY valid JSON, no other text, in this exact shape:
{
  "headline": "one short line",
  "narrative": "the full assessment, plain prose with the limited markdown described above"
}`;
}

async function handleCheck(request, env) {
  const { text, name, pin } = await request.json();

  if (!checkAuth(name, pin, env)) {
    return jsonResponse({ error: "Invalid name or PIN." }, 401, env);
  }
  if (!text || !text.trim()) {
    return jsonResponse({ error: "No text provided." }, 400, env);
  }

  try {
    const raw = await callClaude(env, CHECK_SYSTEM_PROMPT, text, 2000);
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (e) {
      // Model occasionally wraps JSON in a code fence — strip and retry.
      const stripped = raw.replace(/^```json\s*/i, "").replace(/```\s*$/i, "").trim();
      parsed = JSON.parse(stripped);
    }
    return jsonResponse(parsed, 200, env);
  } catch (err) {
    return jsonResponse({ error: String(err.message || err) }, 502, env);
  }
}

async function handleAssist(request, env) {
  const { text, name, pin, question } = await request.json();

  if (!checkAuth(name, pin, env)) {
    return jsonResponse({ error: "Invalid name or PIN." }, 401, env);
  }
  if (!text || !text.trim()) {
    return jsonResponse({ error: "No text provided." }, 400, env);
  }

  const userMessage = question
    ? `Here is my piece of writing:\n\n${text}\n\nMy question: ${question}`
    : `Here is my piece of writing. Please give me coaching feedback on it:\n\n${text}`;

  try {
    const feedback = await callClaude(env, ASSIST_SYSTEM_PROMPT, userMessage, 1200);
    return jsonResponse({ feedback }, 200, env);
  } catch (err) {
    return jsonResponse({ error: String(err.message || err) }, 502, env);
  }
}

async function handleAiCheck(request, env) {
  const { text, name, pin } = await request.json();

  if (!checkAuth(name, pin, env)) {
    return jsonResponse({ error: "Invalid name or PIN." }, 401, env);
  }
  if (!text || !text.trim()) {
    return jsonResponse({ error: "No text provided." }, 400, env);
  }

  try {
    const raw = await callClaude(env, AI_LIKELIHOOD_SYSTEM_PROMPT, text, 600);
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (e) {
      const stripped = raw.replace(/^```json\s*/i, "").replace(/```\s*$/i, "").trim();
      parsed = JSON.parse(stripped);
    }
    return jsonResponse(parsed, 200, env);
  } catch (err) {
    return jsonResponse({ error: String(err.message || err) }, 502, env);
  }
}

// ---- History (D1) ----
// Parents see every child's history; children see only their own. This is
// a convenience filter, not real access control — the shared-PIN scheme
// already means anyone can log in as anyone (see Action note in the vault).
const PARENT_NAMES = ["Mike", "Lucy"];

function titleFromText(text) {
  const oneLine = text.trim().replace(/\s+/g, " ");
  if (oneLine.length <= 60) return oneLine;
  const cut = oneLine.slice(0, 60);
  const lastSpace = cut.lastIndexOf(" ");
  return (lastSpace > 20 ? cut.slice(0, lastSpace) : cut) + "...";
}

async function saveHistory(env, { name, type, text, result }) {
  if (!env.DB) return; // No DB bound yet — history is a no-op until Mike runs the D1 setup step.
  try {
    await env.DB.prepare(
      "INSERT INTO history (name, type, created_at, title, essay_text, result_json) VALUES (?, ?, ?, ?, ?, ?)"
    )
      .bind(name, type, new Date().toISOString(), titleFromText(text), text, JSON.stringify(result))
      .run();
  } catch (err) {
    // History is a nice-to-have — never let a storage failure break the actual critique/mark response.
    console.error("saveHistory failed", err);
  }
}

async function handleHistoryList(request, env) {
  const { name, pin, type } = await request.json();

  if (!checkAuth(name, pin, env)) {
    return jsonResponse({ error: "Invalid name or PIN." }, 401, env);
  }
  if (!env.DB) {
    return jsonResponse({ error: "History isn't set up yet — see README-deploy.md for the D1 setup step." }, 503, env);
  }

  const isParent = PARENT_NAMES.includes(name);
  try {
    let query;
    if (isParent) {
      query = type
        ? env.DB.prepare("SELECT id, name, type, created_at, title FROM history WHERE type = ? ORDER BY created_at DESC LIMIT 100").bind(type)
        : env.DB.prepare("SELECT id, name, type, created_at, title FROM history ORDER BY created_at DESC LIMIT 100");
    } else {
      query = type
        ? env.DB.prepare("SELECT id, name, type, created_at, title FROM history WHERE name = ? AND type = ? ORDER BY created_at DESC LIMIT 50").bind(name, type)
        : env.DB.prepare("SELECT id, name, type, created_at, title FROM history WHERE name = ? ORDER BY created_at DESC LIMIT 50").bind(name);
    }
    const { results } = await query.all();
    return jsonResponse({ entries: results }, 200, env);
  } catch (err) {
    return jsonResponse({ error: String(err.message || err) }, 502, env);
  }
}

async function handleHistoryGet(request, env) {
  const { name, pin, id } = await request.json();

  if (!checkAuth(name, pin, env)) {
    return jsonResponse({ error: "Invalid name or PIN." }, 401, env);
  }
  if (!env.DB) {
    return jsonResponse({ error: "History isn't set up yet — see README-deploy.md for the D1 setup step." }, 503, env);
  }
  if (!id) {
    return jsonResponse({ error: "No id provided." }, 400, env);
  }

  try {
    const row = await env.DB.prepare("SELECT * FROM history WHERE id = ?").bind(id).first();
    if (!row) {
      return jsonResponse({ error: "Not found." }, 404, env);
    }
    const isParent = PARENT_NAMES.includes(name);
    if (!isParent && row.name !== name) {
      return jsonResponse({ error: "Not found." }, 404, env); // Don't reveal existence of another child's entry.
    }
    return jsonResponse(
      {
        id: row.id,
        name: row.name,
        type: row.type,
        created_at: row.created_at,
        title: row.title,
        essay_text: row.essay_text,
        result: JSON.parse(row.result_json),
      },
      200,
      env
    );
  } catch (err) {
    return jsonResponse({ error: String(err.message || err) }, 502, env);
  }
}

async function handleCritique(request, env) {
  const { text, name, pin } = await request.json();

  if (!checkAuth(name, pin, env)) {
    return jsonResponse({ error: "Invalid name or PIN." }, 401, env);
  }
  if (!text || !text.trim()) {
    return jsonResponse({ error: "No text provided." }, 400, env);
  }

  const userMessage = `Here is the writing to critique. Divide it into its own natural paragraphs yourself — do not assume blank lines mark the boundaries:\n\n${text}`;

  try {
    // Higher token budget than the other endpoints: the response must
    // reproduce the entire essay verbatim (split across paragraph fields)
    // as well as the feedback itself, which roughly doubles the output
    // length relative to the input.
    const raw = await callClaude(env, buildCritiquePrompt(name), userMessage, 6000);
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (e) {
      const stripped = raw.replace(/^```json\s*/i, "").replace(/```\s*$/i, "").trim();
      parsed = JSON.parse(stripped);
    }
    await saveHistory(env, { name, type: "critique", text, result: parsed });
    return jsonResponse(parsed, 200, env);
  } catch (err) {
    return jsonResponse({ error: String(err.message || err) }, 502, env);
  }
}

async function handleMark(request, env) {
  const { text, name, pin, context } = await request.json();

  if (!checkAuth(name, pin, env)) {
    return jsonResponse({ error: "Invalid name or PIN." }, 401, env);
  }
  if (!text || !text.trim()) {
    return jsonResponse({ error: "No text provided." }, 400, env);
  }

  const userMessage = context
    ? `Here is the piece of writing to mark:\n\n${text}\n\nExtra context from the writer: ${context}`
    : `Here is the piece of writing to mark:\n\n${text}`;

  try {
    const raw = await callClaude(env, buildMarkPrompt(name), userMessage, 1500);
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (e) {
      const stripped = raw.replace(/^```json\s*/i, "").replace(/```\s*$/i, "").trim();
      parsed = JSON.parse(stripped);
    }
    await saveHistory(env, { name, type: "mark", text, result: parsed });
    return jsonResponse(parsed, 200, env);
  } catch (err) {
    return jsonResponse({ error: String(err.message || err) }, 502, env);
  }
}

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders(env) });
    }

    const url = new URL(request.url);

    if (request.method === "POST" && url.pathname === "/check") {
      return handleCheck(request, env);
    }
    if (request.method === "POST" && url.pathname === "/assist") {
      return handleAssist(request, env);
    }
    if (request.method === "POST" && url.pathname === "/ai-check") {
      return handleAiCheck(request, env);
    }
    if (request.method === "POST" && url.pathname === "/critique") {
      return handleCritique(request, env);
    }
    if (request.method === "POST" && url.pathname === "/mark") {
      return handleMark(request, env);
    }
    if (request.method === "POST" && url.pathname === "/history/list") {
      return handleHistoryList(request, env);
    }
    if (request.method === "POST" && url.pathname === "/history/get") {
      return handleHistoryGet(request, env);
    }

    return jsonResponse(
      { error: "Not found. Use POST /check, /assist, /ai-check, /critique, /mark, /history/list, or /history/get." },
      404,
      env
    );
  },
};
