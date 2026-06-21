/**
 * Family Writing Assistant — Cloudflare Worker
 *
 * Three endpoints:
 *   POST /check     — grammar, spelling, punctuation and style/clarity check
 *   POST /assist     — writing feedback and coaching (NOT finished-text generation)
 *   POST /ai-check    — qualitative AI-writing-likelihood self-check (heuristic, not a
 *                        calibrated classifier — see ASSESS_SYSTEM_PROMPT for caveats)
 *
 * Required Worker secrets/vars (set via `wrangler secret put` or the
 * Cloudflare dashboard — Settings > Variables):
 *   ANTHROPIC_API_KEY   — your Anthropic API key (secret)
 *   FAMILY_PINS         — JSON string, e.g. {"Mike":"1234","Lucy":"2345","Benjamin":"3456","Joel":"4567","Charlotte":"5678"} (secret)
 *   ALLOWED_ORIGIN      — the GitHub Pages origin, e.g. https://yourusername.github.io (var)
 *   MODEL               — optional, defaults to claude-haiku-4-5-20251001 (var)
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

    return jsonResponse({ error: "Not found. Use POST /check, /assist, or /ai-check." }, 404, env);
  },
};
