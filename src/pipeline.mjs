import { assess } from "./core.mjs";

export const LANGS = { en: "English", es: "Spanish", fr: "French", de: "German", pt: "Portuguese", it: "Italian", ja: "Japanese", zh: "Chinese", ko: "Korean", ar: "Arabic", hi: "Hindi" };
export const langName = (c) => LANGS[c] || c;

const SYS = "You are a careful linguist helping two people who do not share a language. Reply with JSON only, no commentary.";

function analyzePrompt(text, from, to) {
  return `A person writes this message in ${langName(from)}:
"""${text}"""
Decide whether it has a consequential ambiguity: two or more plausible meanings that a listener could act on differently (who, when, what, how many, scope, obligation, negation, a word with two senses). Style differences and trivial vagueness do not count.
If it is ambiguous, give 2 to 4 distinct readings (at most 4). For each reading give:
- "label": 2-5 word name of the reading, in ${langName(from)}
- "paraphrase": the message rewritten in ${langName(from)} so that only this reading remains possible
- "translation": a natural ${langName(to)} translation of that paraphrase
- "consequence": one short sentence in ${langName(from)} saying what the listener would do or believe under this reading
If it is not ambiguous, return one reading with the plain translation.
Return: {"ambiguous": true|false, "focus": "the exact word or phrase that causes it, in ${langName(from)}, or empty", "readings": [{"label":"","paraphrase":"","translation":"","consequence":""}]}`;
}

export async function translate(llm, text, from, to) {
  const out = await llm.chat([
    { role: "system", content: "You are a professional translator. Reply with only the translation." },
    { role: "user", content: `Translate from ${langName(from)} to ${langName(to)}:\n${text}` },
  ], { maxTokens: 1500, temperature: 0 });
  return out.replace(/^["“]|["”]$/g, "").trim();
}
// Independent: the back-translator sees only the translated sentence, never the source.
export const backTranslate = (llm, text, from, to) => translate(llm, text, to, from);

export async function analyze(llm, { text, from, to }) {
  const t0 = Date.now();
  const [analysis, naiveTranslation] = await Promise.all([
    llm.json([{ role: "system", content: SYS }, { role: "user", content: analyzePrompt(text, from, to) }], { maxTokens: 3000 }),
    translate(llm, text, from, to),
  ]);
  const raw = Array.isArray(analysis.readings) ? analysis.readings.slice(0, 4) : [];
  const readings = raw.filter((r) => r && r.translation && r.paraphrase).map((r, i) => ({
    id: "ABCD"[i], label: String(r.label || `Reading ${"ABCD"[i]}`), paraphrase: String(r.paraphrase),
    translation: String(r.translation), consequence: String(r.consequence || ""),
  }));
  if (!readings.length) throw new Error("model returned no usable readings");
  const ambiguousClaim = Boolean(analysis.ambiguous) && readings.length >= 2;
  if (!ambiguousClaim) {
    return { text, from, to, ambiguous: false, flagged: false, readings: readings.slice(0, 1), naive: { translation: naiveTranslation }, check: null, model: llm.model, ms: Date.now() - t0 };
  }
  const backs = await Promise.all([...readings.map((r) => r.translation), naiveTranslation].map((t) => backTranslate(llm, t, from, to)));
  readings.forEach((r, i) => { r.back = backs[i]; });
  const naive = { translation: naiveTranslation, back: backs[readings.length] };
  const check = assess(readings, naive);
  if (check.collapsedTo) naive.collapsedTo = check.collapsedTo;
  return {
    text, from, to, ambiguous: true, focus: String(analysis.focus || ""),
    // flagged = the model saw ambiguity AND the independent round trips really diverge
    flagged: check.survives, readings, naive, check, model: llm.model, ms: Date.now() - t0,
  };
}
