# @absolutejs/voice benchmarks

Performance & accuracy benchmarks for [`@absolutejs/voice`](https://github.com/absolutejs/voice) — STT, TTS, duplex, telephony, and session soak tests, plus head-to-head comparisons against Vapi.

These consume the **published** `@absolutejs/voice` package and provider adapters, so they double as a real-world consumer of the public API.

For intake transcription, run `bun run bench:intake:accuracy`. It compares
Deepgram Flux with OpenAI on the domain-heavy fixture set and reports both WER
and expected-term recall, so a provider cannot pass by getting filler words right
while missing the names and phrases that populate durable profile fields.

## Setup

```bash
bun install
cp .env.example .env   # add provider API keys for live benchmarks
```

## Running

Benchmarks are exposed as `bench:*` scripts. Examples:

```bash
bun run bench:tts                 # TTS latency across providers
bun run bench:stt all telephony   # STT accuracy on telephony fixtures
bun run bench:duplex              # full-duplex turn-taking
bun run bench:telephony:run       # telephony suite -> benchmark-results/
```

Run `bun run` to list every benchmark target.

Results are written to `benchmark-results/` (gitignored). Some accent/code-switch
suites read the multilingual corpus from a sibling `voice-fixtures-multilingual`
checkout (`../../voice-fixtures-multilingual`).

## Vapi comparison

`benchmarks/vapi-baseline.example.json` is a template — copy it to
`benchmarks/your-vapi-metrics.json` (gitignored) with your own Vapi numbers to
compare against.
