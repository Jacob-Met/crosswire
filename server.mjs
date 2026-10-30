import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, join, normalize } from "node:path";
import { createLlm, LlmUnavailable } from "./src/llm.mjs";
import { analyze, LANGS } from "./src/pipeline.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml" };

export function createApp({ llm = createLlm() } = {}) {
  const rooms = new Map();
  const pending = new Map(); // analysisId -> {room, seat, analysis, at}
  const room = (id = "main") => {
    id = String(id).slice(0, 40).replace(/[^\w-]/g, "") || "main";
    if (!rooms.has(id)) rooms.set(id, { seats: { a: { name: "Maya", lang: "en" }, b: { name: "Diego", lang: "es" } }, messages: [], rev: 0 });
    return rooms.get(id);
  };
  const other = (s) => (s === "a" ? "b" : "a");

  async function handle(req, res) {
    const url = new URL(req.url, "http://x");
    const send = (code, obj) => { res.writeHead(code, { "Content-Type": "application/json" }); res.end(JSON.stringify(obj)); };
    const body = async () => { let b = ""; for await (const c of req) { b += c; if (b.length > 20000) throw new Error("too large"); } return b ? JSON.parse(b) : {}; };

    if (url.pathname.startsWith("/api/")) {
      try {
        if (req.method === "GET" && url.pathname === "/api/state") {
          const r = room(url.searchParams.get("room"));
          return send(200, { seats: r.seats, messages: r.messages, rev: r.rev, langs: LANGS, llm: { available: llm.available, model: llm.model } });
        }
        if (req.method !== "POST") return send(405, { error: "method" });
        const b = await body();
        const r = room(b.room);
        if (url.pathname === "/api/seats") {
          for (const s of ["a", "b"]) {
            const v = b.seats?.[s]; if (!v) continue;
            if (v.lang in LANGS) r.seats[s].lang = v.lang;
            if (typeof v.name === "string" && v.name.trim()) r.seats[s].name = v.name.trim().slice(0, 24);
          }
          if (r.seats.a.lang === r.seats.b.lang) return send(400, { error: "Pick two different languages." });
          r.rev++; return send(200, { seats: r.seats });
        }
        if (url.pathname === "/api/analyze") {
          const text = String(b.text || "").trim().slice(0, 600);
          if (!text || !["a", "b"].includes(b.seat)) return send(400, { error: "text and seat required" });
          if (!llm.available) return send(503, { error: "NEBIUS_API_KEY is not set on the server, so messages cannot be checked or translated.", code: "NO_KEY" });
          const from = r.seats[b.seat].lang, to = r.seats[other(b.seat)].lang;
          const analysis = await analyze(llm, { text, from, to });
          const id = randomUUID();
          pending.set(id, { room: b.room || "main", seat: b.seat, analysis, at: Date.now() });
          for (const [k, v] of pending) if (Date.now() - v.at > 30 * 60000) pending.delete(k);
          return send(200, { analysisId: id, ...analysis });
        }
        if (url.pathname === "/api/send") {
          const p = pending.get(b.analysisId);
          if (!p || p.seat !== b.seat) return send(404, { error: "Analysis expired. Check the message again." });
          const a = p.analysis;
          let reading = a.readings[0], pick = null;
          if (a.flagged) {
            reading = a.readings.find((x) => x.id === b.pick);
            if (!reading) return send(409, { error: "This message is ambiguous. Pick the reading you meant before sending.", code: "PICK_REQUIRED" });
            pick = reading.id;
          }
          pending.delete(b.analysisId);
          const m = {
            id: randomUUID().slice(0, 8), seat: b.seat, at: Date.now(), text: a.text,
            delivered: reading.translation, // what the other person reads
            intended: a.flagged ? { id: reading.id, paraphrase: reading.paraphrase, consequence: reading.consequence } : null,
            options: a.flagged ? a.readings.map((x) => ({ id: x.id, text: x.translation, label: x.label, paraphrase: x.paraphrase })) : null,
            focus: a.flagged ? a.focus : null, ambiguityChecked: a.ambiguous && !a.flagged ? true : false,
            receiverRead: null, status: a.flagged ? "awaiting" : "plain",
          };
          r.messages.push(m); r.rev++;
          return send(200, { message: m });
        }
        if (url.pathname === "/api/understood") {
          const m = r.messages.find((x) => x.id === b.id);
          if (!m || !m.options) return send(404, { error: "no such message" });
          if (b.seat === m.seat) return send(400, { error: "Only the recipient answers this." });
          if (!m.options.some((o) => o.id === b.reading)) return send(400, { error: "unknown reading" });
          m.receiverRead = b.reading;
          m.status = b.reading === m.intended.id ? "aligned" : "mismatch";
          r.rev++; return send(200, { message: m });
        }
        if (url.pathname === "/api/clarify") {
          // After a mismatch, show the sender's intended reading to the recipient in their language.
          const m = r.messages.find((x) => x.id === b.id);
          if (!m || m.status !== "mismatch") return send(404, { error: "nothing to clarify" });
          m.status = "resolved"; r.rev++; return send(200, { message: m });
        }
        return send(404, { error: "not found" });
      } catch (e) {
        if (e instanceof LlmUnavailable) return send(503, { error: e.message, code: "NO_KEY" });
        console.error("api error:", e.message);
        return send(502, { error: "The language model call failed: " + e.message });
      }
    }
    let p = url.pathname === "/" ? "/index.html" : url.pathname;
    p = normalize(p).replace(/^(\.\.[/\\])+/, "");
    try {
      const data = await readFile(join(here, "public", p));
      const ext = p.slice(p.lastIndexOf("."));
      res.writeHead(200, { "Content-Type": TYPES[ext] || "application/octet-stream" }); res.end(data);
    } catch { res.writeHead(404); res.end("not found"); }
  }
  return createServer((req, res) => { handle(req, res).catch((e) => { res.writeHead(500); res.end(String(e.message)); }); });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT || 4417);
  const llm = createLlm();
  createApp({ llm }).listen(port, () => console.log(`CROSSWIRE on http://localhost:${port} (${llm.available ? "Nemotron live: " + llm.model : "NEBIUS_API_KEY not set"})`));
}
