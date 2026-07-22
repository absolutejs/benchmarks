# STT benchmark methodology

## Claims and tracks

Every result must identify one prompt track:

- `unprompted`: no domain prompt, phrase hints, or reference-derived lexicon.
- `production-context`: only context available in the deployed product before
  the utterance, such as language strategy and an application-owned lexicon.
- `oracle-seeded`: expected text or expected terms may influence hints or
  correction. These results measure an upper bound and cannot be compared to
  unprompted production claims.

Corrected targets are automatically labeled `oracle-seeded`. Standard runs
default to `production-context`; use `--track unprompted` for a provider-only
baseline.

## Reproducibility

1. Run `bun run corpus:verify`.
2. Record provider, model, package versions, pricing date, and configuration.
3. Use at least five repeats for live streaming comparisons.
4. Build a checksummed artifact with `bun run bench:stt:artifact -- <report>`.
5. Compare providers on identical fixture IDs with
   `bun run bench:stt:compare -- <baseline> <candidate>`.

Artifacts include the repository commit, Bun/platform metadata, corpus and
audio hashes, split and license metadata, seed, prompt track, C/S/D/I counts,
micro and macro WER, sentence error rate, critical-field outcomes, and adapter
contract checks. Paired bootstrap intervals use a deterministic seed and report
the probability that lower candidate WER is better.

## Corpus governance

Public-test references are visible and are therefore unsuitable for claiming a
fully blind evaluation. Development data may be tuned against. Private held-out
references must not enter provider configuration, prompts, correction rules, or
source control. The held-out ingestion script requires explicit consent
metadata, hashes audio, and refuses to write into the public benchmark folder.

Demographic balance, natural conversational speech, device diversity, and
deployment-specific vocabulary require a consented private corpus. Publish only
aggregate results where privacy and agreements permit it.

## Stress matrix and outcome metrics

`corpus:matrix` deterministically creates gain, clipping, 10 dB SNR noise, and
100 ms periodic packet-loss conditions. Report each condition independently;
do not average stress conditions into a clean-audio headline.

WER is accompanied by required critical-field accuracy, complete required
profile rate, fixture pass rate, latency, calibration, conformance, and—when
provider pricing is supplied—cost per passing fixture. A provider winner must
improve the deployment outcome without a material latency or cost regression.
