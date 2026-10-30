import { test } from "node:test";
import assert from "node:assert/strict";
import { similarity, divergence, assess, tokens } from "../src/core.mjs";
import { extractJson, stripReasoning, createLlm, LlmUnavailable } from "../src/llm.mjs";
import { analyze } from "../src/pipeline.mjs";
import { createApp } from "../server.mjs";

// Scripted fake model: routes by prompt content, no network.
function fakeLlm({ ambiguous = true, backSame = false } = {}) {
  const backs = { "Vi su pato.": "I saw his duck.", "La vi agacharse.": backSame ? "I saw his duck." : "I saw her crouch." };
  return {
    model: "fake/nemotron", available: true,
    async json() {
      return ambiguous
        ? { ambiguous: true, focus: "duck", readings: [
            { label: "the bird", paraphrase: "I saw her pet duck.", translation: "Vi su pato.", consequence: "They picture a bird." },
            { label: "the motion", paraphrase: "I saw her lower her head.", translation: "La vi agacharse.", consequence: "They picture her ducking." }] }
        : { ambiguous: false, readings: [{ label: "plain", paraphrase: "The cat sleeps.", translation: "El gato duerme.", consequence: "" }] };
    },
    async chat(msgs) {
      const t = msgs[1].content.split("\n").slice(1).join("\n").trim();
      return backs[t] || (t.startsWith("I saw her duck") ? "La vi agacharse." : t === "La vi agacharse." ? backs[t] : "I saw her crouch.");
    },
  };
}

test("similarity ignores accents, case, stopwords", () => {
  assert.equal(similarity("The Café is open", "cafe open"), 1);
  assert.ok(divergence("I saw her crouch", "I saw his duck") > 0.3);
  assert.deepEqual(tokens("The dogs"), ["dog"]);
});

test("assess flags diverging round trips and finds the silent collapse", () => {
  const r = [{ id: "A", translation: "x", back: "meet me at the bank" }, { id: "B", translation: "y", back: "meet me at the riverbank shore" }];
  const c = assess(r, { translation: "z", back: "meet me at the bank" });
  assert.equal(c.survives, true);
  assert.equal(c.collapsedTo, "A");
});

test("assess does not flag when round trips agree", () => {
  const r = [{ id: "A", translation: "x", back: "send it by friday" }, { id: "B", translation: "x", back: "send it by Friday" }];
  assert.equal(assess(r, null).survives, false);
});

test("extractJson survives fences, reasoning tags and chatter", () => {
  assert.deepEqual(extractJson('<think>{"no":1}</think>Sure:\n```json\n{"a":[1,{"b":"}"}]}\n```'), { a: [1, { b: "}" }] });
  assert.equal(stripReasoning("<think>x</think> hi"), "hi");
  assert.throws(() => extractJson("nothing"));
});

test("llm adapter calls Token Factory with Bearer key and Nemotron model; no key throws", async () => {
  let seen;
  const llm = createLlm({ apiKey: "k-test", model: "nvidia/test", baseUrl: "https://example.test/v1", fetchImpl: async (u, o) => { seen = { u, o }; return { ok: true, json: async () => ({ choices: [{ message: { content: "<think>r</think>hola" } }] }) }; } });
  assert.equal(await llm.chat([{ role: "user", content: "x" }]), "hola");
  assert.equal(seen.u, "https://example.test/v1/chat/completions");
  assert.equal(seen.o.headers.Authorization, "Bearer k-test");
  assert.equal(JSON.parse(seen.o.body).model, "nvidia/test");
  assert.ok(JSON.parse(seen.o.body).max_tokens >= 1500);
  await assert.rejects(createLlm({ apiKey: "" }).chat([]), LlmUnavailable);
});

test("pipeline: ambiguous sentence is flagged and the plain translation is shown to have collapsed", async () => {
  const a = await analyze(fakeLlm(), { text: "I saw her duck.", from: "en", to: "es" });
  assert.equal(a.flagged, true);
  assert.equal(a.readings.length, 2);
  assert.equal(a.naive.collapsedTo, "B");
});

test("pipeline: model claims ambiguity but round trips agree -> not blocked", async () => {
  const a = await analyze(fakeLlm({ backSame: true }), { text: "I saw her duck.", from: "en", to: "es" });
  assert.equal(a.ambiguous, true);
  assert.equal(a.flagged, false);
});

test("pipeline: unambiguous sentence goes straight through", async () => {
  const a = await analyze(fakeLlm({ ambiguous: false }), { text: "The cat sleeps.", from: "en", to: "es" });
  assert.equal(a.flagged, false);
  assert.equal(a.readings[0].translation, "El gato duerme.");
});

async function withServer(llm, fn) {
  const srv = createApp({ llm }).listen(0);
  await new Promise((r) => srv.once("listening", r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  const post = async (p, b) => { const r = await fetch(base + p, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ room: "t", ...b }) }); return { status: r.status, body: await r.json() }; };
  try { await fn(post, base); } finally { srv.close(); }
}

test("server: cannot send a flagged message without picking; pick delivers that reading; receiver mismatch is recorded", async () => {
  await withServer(fakeLlm(), async (post, base) => {
    const a = (await post("/api/analyze", { seat: "a", text: "I saw her duck." })).body;
    assert.equal(a.flagged, true);
    const noPick = await post("/api/send", { seat: "a", analysisId: a.analysisId });
    assert.equal(noPick.status, 409);
    const sent = (await post("/api/send", { seat: "a", analysisId: a.analysisId, pick: "B" })).body.message;
    assert.equal(sent.delivered, "La vi agacharse.");
    assert.equal(sent.intended.id, "B");
    const u = (await post("/api/understood", { seat: "b", id: sent.id, reading: "A" })).body.message;
    assert.equal(u.status, "mismatch");
    const st = await (await fetch(base + "/api/state?room=t")).json();
    assert.equal(st.messages.length, 1);
    assert.equal((await post("/api/clarify", { id: sent.id })).body.message.status, "resolved");
  });
});

test("server: no API key gives a clear 503 and the key never appears in state", async () => {
  await withServer(createLlm({ apiKey: "" }), async (post, base) => {
    const r = await post("/api/analyze", { seat: "a", text: "hello" });
    assert.equal(r.status, 503);
    assert.match(r.body.error, /NEBIUS_API_KEY/);
    const st = await (await fetch(base + "/api/state")).json();
    assert.equal(st.llm.available, false);
  });
});
