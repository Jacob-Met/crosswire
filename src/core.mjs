// Deterministic core: the model proposes readings and translations; this code decides
// whether the ambiguity is real, using only string comparison of independent back-translations.

const STOP = new Set("a an the of to in on at is are was were be been it its that this and or but for with as by from i you he she they we".split(" "));

export function norm(s) {
  return String(s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, " ").replace(/\s+/g, " ").trim();
}
function stem(w) { return w.length > 3 ? w.replace(/(ing|ed|es|s)$/, "") : w; }
export function tokens(s) {
  const t = norm(s).split(" ").filter(Boolean);
  const content = t.filter((w) => !STOP.has(w));
  return (content.length ? content : t).map(stem);
}
// Token-set Jaccard similarity, 1 = same words, 0 = nothing shared.
export function similarity(a, b) {
  const A = new Set(tokens(a)), B = new Set(tokens(b));
  if (!A.size && !B.size) return 1;
  let inter = 0; for (const x of A) if (B.has(x)) inter++;
  return inter / (A.size + B.size - inter);
}
export const divergence = (a, b) => 1 - similarity(a, b);

export const THRESHOLD = 0.3;

// readings: [{id, label, paraphrase, translation, back}]; naive: {translation, back}
export function assess(readings, naive, threshold = THRESHOLD) {
  const pairs = [];
  for (let i = 0; i < readings.length; i++)
    for (let j = i + 1; j < readings.length; j++) {
      pairs.push({
        a: readings[i].id, b: readings[j].id,
        backDivergence: round(divergence(readings[i].back, readings[j].back)),
        translationsIdentical: norm(readings[i].translation) === norm(readings[j].translation),
      });
    }
  const maxDiv = pairs.reduce((m, p) => Math.max(m, p.backDivergence), 0);
  // A reading counts as distinct if some other reading's round trip differs from it enough.
  const survives = readings.length >= 2 && maxDiv >= threshold;
  // Which reading did a plain fluent translation silently commit to?
  let collapsedTo = null, margin = 0;
  if (naive?.back && readings.length >= 2) {
    const scored = readings.map((r) => ({ id: r.id, s: similarity(naive.back, r.back) })).sort((x, y) => y.s - x.s);
    margin = round(scored[0].s - scored[1].s);
    if (margin > 0.05) collapsedTo = scored[0].id;
  }
  return { survives, maxDivergence: round(maxDiv), threshold, pairs, collapsedTo, collapseMargin: margin };
}
const round = (x) => Math.round(x * 100) / 100;
