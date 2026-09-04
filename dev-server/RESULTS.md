# Results — `absolute dev` boot

App under test: a production Vue application — 74 pages, 404 single-file
components, 1463 source files, 112 top-level imports in its server entry.

Machine: WSL2, 10 vCPU, 12 GiB, Bun 1.4.0. Idle unless noted. Warm restart
(`build/` and `.absolutejs/` kept), which is what a restart during a working
day looks like.

| | 0.20.0-beta.70 | 0.20.0-beta.71 |
| --- | --- | --- |
| first byte | 3.7s | **3.5s** |
| ready | ~56s | **4.1s** |
| first page | 166s | **5.8s** |
| build trace, cold | 122s | **1.3s** |
| on-demand page build | n/a | **660ms** |
| dev output on disk | 880 MB | **12 MB** |

Reproduce: `bun run bench --app <your app> --mode warm --runs 5`.

## What moved, and by how much

Measured one workstream at a time on the same app, each against the merged
state before it. Times are the cold build trace unless stated.

| change | effect |
| --- | --- |
| Dev server bundles stopped inlining `node_modules` | SSR pages 395 MB → 149 MB; sourcemap chain 14.7s → 4.1s |
| Shared chunks in dev (`splitting` was off) | postprocess 69.7s → 12.0s; build dir 491 MB → 206 MB |
| Vue compile + sourcemap chain on a worker pool | `compile/vue` 45s → 26s; SSR pages 149 MB → 37 MB |
| Four whole-bundle rewrite passes merged into one | rewrite phases 5.9s → 0.86s |
| Pages built on demand instead of at boot | ready 56s → 5.5s |
| CLI split and dynamically imported | CLI's own parse 1.0s → 26ms |
| On-demand page build made to pay for itself | 1.35s → 660ms |

The step change is the sixth row. The dev server stopped building all 74
pages at boot and started building the one you opened, in about 0.7s.
`absolute dev --eager` restores the old behaviour.

## What did not move

A cross-process pre-scan, which computes two of the boot's disk scans in the
CLI parent while the child is still starting. It removes real work — the two
scans drop from hundreds of milliseconds to single digits — and it still
changes nothing a developer can feel:

| | pre-scan on | pre-scan off |
| --- | --- | --- |
| first byte | 3.4s / 3.8s | 3.3s / 3.6s |
| first page | 5.4s / 6.5s | 5.1s / 6.0s |
| ready | 3.97s / 4.47s | 3.93s / 4.30s |

Alternating A/B, two rounds each, idle machine. The child cannot adopt the
pre-scan's payload until the user's own entry has finished importing, and
those scans were running inside that same window — so it wins a race that
something else was already losing. It ships off by default.

This one is worth knowing about for a second reason: measured non-alternating,
minutes apart, the same change looked like a 2× win in one direction and a
2× loss in the other. Both were the machine, not the code.

## The floor

About 4.6s of this app's remaining boot is its own `server.ts` importing 112
modules eagerly — postgres, auth, sync, ai. The framework overlaps that work
but cannot remove it, and no framework change will: it is a single thread
evaluating the application's module graph.

Lazy-importing the heavy ones is the next real win, and it belongs in the
application rather than the framework.
