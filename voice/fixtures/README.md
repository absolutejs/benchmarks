## Bundled Fixtures

This directory contains small public benchmark fixtures for `@absolutejs/voice`.

### Sources

- `quietly-alone-clean.pcm`
- `traveled-back-route-clean.pcm`
- `rainstorms-noisy.pcm`

These are derived from public-domain LibriSpeech material, with the noisy variant created by mixing synthetic noise into a clean base utterance for adapter comparison.

- `stella-india-english37.pcm`
- `stella-ghana-english507.pcm`
- `stella-singapore-english655.pcm`
- `stella-pakistan-english519.pcm`
- `stella-jamaica-jamaican-creole-english1.pcm`
- `stella-liberia-liberian-pidgin-english2.pcm`
- `stella-sierra-leone-krio5.pcm`
- `stella-bulgaria-bulgarian20.pcm`

These are derived from the Speech Accent Archive at George Mason University using the shared "Please call Stella..." elicitation paragraph.

Archive:

- https://accent.gmu.edu/

License:

- https://creativecommons.org/licenses/by-nc-sa/2.0/

Selected speaker pages:

- https://accent.gmu.edu/browse_language.php?function=detail&speakerid=96
- https://accent.gmu.edu/browse_language.php?function=detail&speakerid=1800
- https://accent.gmu.edu/browse_language.php?function=detail&speakerid=3033
- https://accent.gmu.edu/browse_language.php?function=detail&speakerid=1882
- https://accent.gmu.edu/browse_language.php?function=detail&speakerid=967
- https://accent.gmu.edu/browse_language.php?function=detail&speakerid=2141
- https://accent.gmu.edu/browse_language.php?function=detail&speakerid=1140
- https://accent.gmu.edu/browse_language.php?function=detail&speakerid=2691

### Synthetic Multi-Turn Fixtures

- `multiturn-two-clean.pcm`
- `multiturn-three-mixed.pcm`
- `dialogue-two-clean.pcm`
- `dialogue-two-noisy.pcm`
- `dialogue-three-clean.pcm`
- `dialogue-three-mixed.pcm`

These are synthetic conversation-style fixtures created by concatenating the bundled public-domain base clips with inserted silence to exercise turn commit behavior.

- `multiturn-*` are stress fixtures with tighter pauses.
- `dialogue-*` are dialogue-style fixtures with longer pause boundaries intended to approximate normal guided multi-turn voice use.
- `dialogue-three-clean` is the clean long-form baseline for multi-turn guided capture.
- `dialogue-two-noisy` and `dialogue-three-mixed` keep noisy utterances in the dialogue-style set so turn behavior can be compared against a more realistic clean baseline.
