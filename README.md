# CROSSWIRE

Two people who share a job but not a language chat side by side. Before a message is translated, CROSSWIRE checks whether it has a consequential ambiguity ("table this proposal", "the doctor told the nurse she should stop") and, if so, makes the speaker pick the meaning they intended. Only that reading is sent. The recipient is then asked how they read it, so a mismatch shows up before anyone acts on it.

A fluent translator silently commits to one reading. CROSSWIRE makes that choice visible.

## Quick start

Requires Node 22+. No npm dependencies.

```sh
export NEBIUS_API_KEY=...        # Nebius Token Factory key
node server.mjs                  # http://localhost:4417
node --test                      # 10 tests, no network needed
```

Open http://localhost:4417. Maya (English) and Diego (Spanish) share one room; pick a sample sentence and press "Check & send". Without a key the app starts and explains that checking is unavailable (HTTP 503); nothing is faked.

Optional env: `PORT`, `CROSSWIRE_MODEL` (default `nvidia/nemotron-3-super-120b-a12b`), `NEBIUS_BASE_URL`.

## How it uses NVIDIA Nemotron on Nebius Token Factory

Every check makes real calls to `https://api.tokenfactory.nebius.com/v1/chat/completions` with `nvidia/nemotron-3-super-120b-a12b` (`src/llm.mjs`). The key is read server-side from `NEBIUS_API_KEY`; the browser never sees it.

Per message (`src/pipeline.mjs`):
1. **Analyze** (JSON): Nemotron decides whether the message has an ambiguity someone could act on differently, names the word causing it, and gives 2 to 4 readings, each with a disambiguated paraphrase, a translation, and the consequence of that reading.
2. **Plain translation**: a separate call translates the message the way an ordinary translator would.
3. **Back-translation**: every reading's translation, and the plain translation, is translated back to the speaker's language by separate calls that never see the source sentence.

The model proposes; the app's own code (`src/core.mjs`) checks. It compares the back-translations by word overlap (Jaccard on normalized, stemmed content words). The message is only flagged if two readings' round trips diverge past a threshold (0.3). If Nemotron claims ambiguity but the round trips agree, the message goes through unblocked. For flagged messages the server refuses to send until a reading is picked (`PICK_REQUIRED`), and the plain translation is scored against each reading to show which one it silently chose.

Why the 120B-A12B Super model: the analysis step needs reliable structured JSON and linguistic judgment across languages; the mixture-of-experts model gave that at roughly 9 s for a full check. The smaller Nano is a drop-in via `CROSSWIRE_MODEL` but was not evaluated here.

## Layout

- `server.mjs` HTTP server and room state (in memory)
- `src/llm.mjs` Token Factory client (key handling, retries, JSON extraction)
- `src/pipeline.mjs` prompts and orchestration
- `src/core.mjs` deterministic divergence check
- `public/` UI, `test/` tests (fake model, no network)

## Limits

- Word-overlap divergence is crude: it can miss ambiguities whose back-translations share words, and can flag paraphrase noise. The threshold was tuned on a handful of sentences.
- A model may miss an ambiguity entirely; CROSSWIRE reduces silent mistranslation, it does not guarantee correctness.
- A check takes several seconds (about six model calls, partly parallel).
- State is in memory, one shared room, no accounts or persistence. Messages are capped at 600 characters.
- Tested with English and Spanish; other listed languages are untested.

## License

MIT, see LICENSE.
