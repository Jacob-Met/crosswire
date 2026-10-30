// Thin client for NVIDIA Nemotron served by Nebius Token Factory (OpenAI-compatible).
// The API key is read from the environment on the server only; the browser never sees it.
export const BASE_URL = process.env.NEBIUS_BASE_URL || "https://api.tokenfactory.nebius.com/v1";
export const MODEL = process.env.CROSSWIRE_MODEL || "nvidia/nemotron-3-super-120b-a12b";

export class LlmUnavailable extends Error {
  constructor(msg) { super(msg); this.code = "NO_KEY"; }
}

export function stripReasoning(text) {
  return String(text || "").replace(/<think>[\s\S]*?<\/think>/g, "").trim();
}

// Pull the first JSON object/array out of a model reply (fences and chatter tolerated).
export function extractJson(text) {
  const s = stripReasoning(text).replace(/```(?:json)?/gi, "");
  const starts = [s.indexOf("{"), s.indexOf("[")].filter((i) => i >= 0);
  if (!starts.length) throw new Error("no JSON in model reply");
  const i = Math.min(...starts);
  const open = s[i], close = open === "{" ? "}" : "]";
  let depth = 0, inStr = false, esc = false;
  for (let k = i; k < s.length; k++) {
    const c = s[k];
    if (inStr) { if (esc) esc = false; else if (c === "\\") esc = true; else if (c === '"') inStr = false; continue; }
    if (c === '"') inStr = true;
    else if (c === open) depth++;
    else if (c === close && --depth === 0) return JSON.parse(s.slice(i, k + 1));
  }
  throw new Error("unterminated JSON in model reply");
}

export function createLlm({ apiKey = process.env.NEBIUS_API_KEY, model = MODEL, baseUrl = BASE_URL, fetchImpl = fetch } = {}) {
  return {
    model,
    available: Boolean(apiKey),
    async chat(messages, { maxTokens = 2500, temperature = 0.2 } = {}) {
      if (!apiKey) throw new LlmUnavailable("NEBIUS_API_KEY is not set");
      let lastErr;
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          const res = await fetchImpl(`${baseUrl}/chat/completions`, {
            method: "POST",
            headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
            body: JSON.stringify({ model, messages, max_tokens: maxTokens, temperature }),
            signal: AbortSignal.timeout(90000),
          });
          if (!res.ok) throw new Error(`Token Factory HTTP ${res.status}`);
          const data = await res.json();
          const content = stripReasoning(data?.choices?.[0]?.message?.content);
          if (!content) throw new Error("empty model reply");
          return content;
        } catch (e) { lastErr = e; }
      }
      throw lastErr;
    },
    async json(messages, opts) {
      const text = await this.chat(messages, opts);
      return extractJson(text);
    },
  };
}
