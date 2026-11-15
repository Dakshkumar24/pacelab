# PaceLab

**Compare. Diagnose. Improve.**

A small open-source testbench that shows how a turn-taking setting behaves on Cloudflare's Agents SDK voice pipeline before you ship it. Two modes, identical except for `WorkersAIFluxSTT`'s `eotThreshold`:

| Mode | `eotThreshold` |
|---|---|
| Standard | 0.70 |
| Patient | 0.85 |

Stack: Cloudflare Workers, Durable Objects + SQLite, `agents/voice` (`withVoice`), Flux STT, Gemma 4 (26B), Aura-1 TTS, React + Vite.

## Run locally

```sh
npm install
npx wrangler login      # Workers AI binding runs remotely, even in dev
npm run dev
```

## Deploy

```sh
npm run deploy
```

Or connect the repo to Cloudflare Workers Builds for deploy-on-push. Starts on the Workers Free plan. The full experiment may exceed the daily free Workers AI allowance.

## Docs

- [`docs/PLAN.md`](docs/PLAN.md): scope, metrics, implementation order, acceptance criteria
- [`docs/FRICTION.md`](docs/FRICTION.md): SDK source audit and friction log
- [`docs/FINDINGS.md`](docs/FINDINGS.md): results and the PM Decision Memo

## Privacy

Transcripts, manual labels and SDK timings only. No raw audio is stored. All test content is fictional.
