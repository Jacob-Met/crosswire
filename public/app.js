const $ = (id) => document.getElementById(id);
const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
const params = new URLSearchParams(location.search);
const ROOM = params.get("room") || "main";
let state = null, lastRev = -1, busy = false, sheetFor = null;
const draft = { a: "", b: "" };

const EXAMPLES = {
  en: ["We need to table this proposal before the board meets.", "Let us meet next Friday.", "I saw her duck."],
  es: ["Vi a la mujer con el telescopio.", "Le dije a Pedro que Luis tenía que pagar.", "Necesito el informe antes de las cinco."],
};

async function api(path, body) {
  const r = await fetch(path, body ? { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ room: ROOM, ...body }) } : undefined);
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(data.error || r.statusText), { data });
  return data;
}
const L = (c) => state.langs[c] || c;
const other = (s) => (s === "a" ? "b" : "a");

async function poll() {
  try {
    const s = await api(`/api/state?room=${encodeURIComponent(ROOM)}`);
    if (s.rev !== lastRev || !state) { state = s; lastRev = s.rev; render(); }
    else state = s;
  } catch {}
}

function render() {
  const m = $("model");
  m.replaceChildren();
  if (state.llm.available) { m.append(el("b", null, "live"), document.createTextNode(` ${state.llm.model.replace("nvidia/", "")} on Nebius Token Factory`)); }
  else m.textContent = "Nemotron offline: NEBIUS_API_KEY is not set";
  const ban = $("banner");
  ban.hidden = state.llm.available;
  if (!state.llm.available) ban.textContent = "No NEBIUS_API_KEY on the server. Messages cannot be translated or checked for ambiguity until it is set. Restart with the key in the environment.";
  for (const s of ["a", "b"]) renderPane(s);
  const show = document.body.dataset.show || "a";
  document.body.dataset.show = show;
  for (const s of ["a", "b"]) { const t = $("tab-" + s); t.textContent = state.seats[s].name; t.setAttribute("aria-pressed", String(show === s)); }
}

function renderPane(s) {
  const pane = $("pane-" + s), seat = state.seats[s];
  const keep = pane.querySelector("textarea");
  if (keep) draft[s] = keep.value;
  const hadFocus = keep && document.activeElement === keep;
  const prevScroll = pane.querySelector(".thread");
  const atBottom = !prevScroll || prevScroll.scrollHeight - prevScroll.scrollTop - prevScroll.clientHeight < 60;
  pane.replaceChildren();

  const head = el("div", "phead");
  head.append(el("span", "who", seat.name));
  const sel = el("select"); sel.setAttribute("aria-label", `${seat.name}'s language`);
  for (const [c, n] of Object.entries(state.langs)) { const o = el("option", null, n); o.value = c; if (c === seat.lang) o.selected = true; sel.append(o); }
  sel.onchange = async () => { try { await api("/api/seats", { seats: { [s]: { lang: sel.value } } }); await poll(); } catch (e) { alert(e.message); render(); } };
  head.append(sel, el("span", "hint", `sees ${state.seats[other(s)].name} in ${L(seat.lang)}`));
  pane.append(head);

  const thread = el("div", "thread"); thread.setAttribute("aria-live", "polite");
  if (!state.messages.length) {
    const e = el("div", "empty");
    e.append(el("p", null, `Write to ${state.seats[other(s)].name} in ${L(seat.lang)}. Try one:`));
    const chips = el("div", "chips");
    for (const ex of EXAMPLES[seat.lang] || EXAMPLES.en) { const c = el("button", "chip", ex); c.onclick = () => { draft[s] = ex; render(); pane.querySelector("textarea").focus(); }; chips.append(c); }
    e.append(chips); thread.append(e);
  }
  for (const m of state.messages) thread.append(messageView(m, s));
  pane.append(thread);

  const form = el("form", "composer");
  const ta = el("textarea"); ta.setAttribute("aria-label", `Message from ${seat.name}`); ta.placeholder = `Message in ${L(seat.lang)}`; ta.value = draft[s]; ta.disabled = busy; ta.maxLength = 600;
  const btn = el("button", null, "Check & send"); btn.disabled = busy;
  ta.onkeydown = (ev) => { if (ev.key === "Enter" && !ev.shiftKey) { ev.preventDefault(); form.requestSubmit(); } };
  form.onsubmit = (ev) => { ev.preventDefault(); const t = ta.value.trim(); if (t) submit(s, t); };
  form.append(ta, btn); pane.append(form);
  if (hadFocus) ta.focus();
  if (atBottom) thread.scrollTop = thread.scrollHeight; else if (prevScroll) thread.scrollTop = prevScroll.scrollTop;
}

function optLabel(m, id) { return m.options.find((o) => o.id === id); }

function messageView(m, viewer) {
  const mine = m.seat === viewer;
  const wrap = el("div", "msg" + (mine ? " mine" : ""));
  wrap.dataset.id = m.id;
  const sender = state.seats[m.seat].name, other_ = state.seats[other(m.seat)].name;
  wrap.append(el("div", "bubble", mine ? m.text : m.delivered));
  if (mine) {
    if (m.intended) wrap.append(el("div", "meta", `You meant: ${m.intended.paraphrase}`));
    if (m.status === "awaiting") wrap.append(el("div", "meta", `${other_} has not answered how they read it yet`));
    if (m.status === "aligned") wrap.append(el("div", "meta ok", `${other_} read it the way you meant`));
    if (m.status === "mismatch") {
      const o = optLabel(m, m.receiverRead);
      wrap.append(el("div", "meta bad", `${other_} read it as: ${o.label} (${o.paraphrase})`));
      const b = el("button", "act", `Tell ${other_} what you meant`); b.onclick = () => act("/api/clarify", { id: m.id }); wrap.append(b);
    }
    if (m.status === "resolved") wrap.append(el("div", "meta ok", `Clarified to ${other_}`));
    if (m.ambiguityChecked) wrap.append(el("div", "meta", "Checked: the possible readings translate the same way"));
  } else {
    if (m.intended) wrap.append(el("div", "meta", `${sender} chose this meaning out of ${m.options.length} possible`));
    if (m.status === "mismatch") wrap.append(el("div", "meta bad", `${sender} was told you read it differently`));
    if (m.status === "resolved") { wrap.append(el("div", "meta ok", `${sender} confirms they meant:`)); wrap.append(el("div", "meta", m.delivered)); }
    if (m.status === "aligned") wrap.append(el("div", "meta ok", `Confirmed, same meaning as ${sender}'s`));
    if (m.options && m.status === "awaiting") {
      const f = el("fieldset", "read"); f.append(el("legend", null, "How did you read it?"));
      let pick = null; const go = el("button", null, "Confirm"); go.type = "button"; go.disabled = true;
      for (const o of m.options) {
        const lab = el("label"); const r = el("input"); r.type = "radio"; r.name = "r" + m.id; r.value = o.id;
        r.onchange = () => { pick = o.id; go.disabled = false; };
        lab.append(r, el("span", null, o.text)); f.append(lab);
      }
      go.onclick = () => act("/api/understood", { id: m.id, seat: viewer, reading: pick });
      f.append(go); wrap.append(f);
    }
  }
  return wrap;
}

async function act(path, body) { try { await api(path, body); await poll(); } catch (e) { alert(e.message); } }

async function submit(s, text) {
  busy = true; draft[s] = text; render();
  showBusy(s, `Asking Nemotron for readings, then translating and back-translating each one`);
  try {
    const a = await api("/api/analyze", { seat: s, text });
    if (a.flagged) { showSheet(s, a); busy = false; render(); return; }
    await api("/api/send", { seat: s, analysisId: a.analysisId });
    draft[s] = ""; hideSheet(); busy = false; await poll(); render();
  } catch (e) {
    busy = false; hideSheet(); render(); alert(e.message);
  }
}

function showBusy(s, msg) {
  const sh = $("sheet"); sh.hidden = false; sh.style.setProperty("--c", `var(--${s})`);
  sh.replaceChildren(); const b = el("div", "busy"); b.append(el("i"), el("span", null, msg + "…")); sh.append(b);
}
function hideSheet() { $("sheet").hidden = true; sheetFor = null; }

function showSheet(s, a) {
  sheetFor = a;
  const sh = $("sheet"); sh.hidden = false; sh.style.setProperty("--c", `var(--${s})`);
  sh.replaceChildren();
  const rcv = state.seats[other(s)].name, snd = state.seats[s].name;
  const h = el("h2"); h.id = "sheet-title";
  h.append(document.createTextNode("Before this goes to " + rcv + ": "));
  if (a.focus) { const mk = el("mark", null, a.focus); h.append(mk, document.createTextNode(" can mean more than one thing")); }
  else h.append(document.createTextNode("this can mean more than one thing"));
  sh.append(h);
  const sub = el("p", "sub");
  sub.append(document.createTextNode(`${snd}, pick the one you meant. Each reading was translated to ${L(a.to)}, then translated back to ${L(a.from)} by a separate call that never saw your original. Round trips differ by `));
  const meter = el("span", "meter"); const fill = el("i"); fill.style.width = Math.min(100, a.check.maxDivergence * 100) + "%"; meter.append(fill);
  sub.append(el("code", null, a.check.maxDivergence.toFixed(2)), meter, document.createTextNode(`(flag at ${a.check.threshold})`));
  sh.append(sub);
  const cols = el("div", "cols");
  for (const r of a.readings) {
    const c = el("div", "col"); c.append(el("h3", null, `${r.id}  ${r.label}`));
    const dl = el("dl");
    const row = (k, v, cls) => { const g = el("div"); g.append(el("dt", null, k), el("dd", cls, v)); dl.append(g); };
    row(`you mean (${L(a.from)})`, r.paraphrase);
    row(`${rcv} would read (${L(a.to)})`, r.translation);
    row(`which comes back as (${L(a.from)})`, r.back, "back");
    if (r.consequence) row("they would then", r.consequence);
    c.append(dl);
    const b = el("button", null, `Send reading ${r.id}`); b.onclick = () => choose(s, a, r.id); c.append(b);
    cols.append(c);
  }
  sh.append(cols);
  const foot = el("div", "foot");
  const nv = el("div", "naive");
  const col = a.naive.collapsedTo ? a.readings.find((r) => r.id === a.naive.collapsedTo) : null;
  nv.append(document.createTextNode("A plain translation would have sent: "), el("b", null, a.naive.translation));
  nv.append(document.createTextNode(col ? `, which reads back as "${a.naive.back}". It silently chose reading ${col.id}.` : ` (reads back as "${a.naive.back}").`));
  foot.append(nv);
  const cancel = el("button", "link", "Edit my message instead"); cancel.onclick = () => { hideSheet(); const ta = $("pane-" + s).querySelector("textarea"); ta && ta.focus(); };
  foot.append(cancel, el("span", "meta", `${a.model.replace("nvidia/", "")} · ${(a.ms / 1000).toFixed(1)}s`));
  sh.append(foot);
  sh.querySelector("button").focus();
}

async function choose(s, a, pick) {
  try { await api("/api/send", { seat: s, analysisId: a.analysisId, pick }); draft[s] = ""; hideSheet(); await poll(); render(); }
  catch (e) { alert(e.message); }
}

for (const s of ["a", "b"]) $("tab-" + s).onclick = () => { document.body.dataset.show = s; render(); };
await poll();
setInterval(() => { if (!busy && !sheetFor) poll(); }, 1500);
