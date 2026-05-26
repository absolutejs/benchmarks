# Results — shared-counter workload

Write round-trip latency (mutation → server-confirmed) and sustained sequential
throughput. One client, sequential awaited writes. Same workload (a single
shared counter, increment + ack), same harness (`scripts/lib/measure.ts`), same
hardware (WSL2 dev box, Bun 1.3, system Node 22). Convex runs in its US-East
cloud; the others run locally.

| Backend                | Where                                       | min (ms) | p50 (ms) | p95 (ms) | p99 (ms) | mean (ms) | writes/sec (seq) |
| ---------------------- | ------------------------------------------- | -------- | -------- | -------- | -------- | --------- | ---------------- |
| **@absolutejs/sync**   | local (WebSocket, loopback)                 | **0.29** | **0.82** | **3.7**  | **6.5**  | **1.2**   | **853**          |
| TanStack DB            | local (REST + `queryCollection`)            | 0.94     | 2.53     | 9.1      | 12.2     | 3.7       | 271              |
| Convex                 | **cloud, US East** (HTTPS)                  | 45.5     | 52.8     | 66.2     | 90.8     | 54.7      | 18               |
| Zero (`zero-cache`)    | local — _scaffolded, partial_ (see `ZERO.md`) | —        | —        | —        | —        | —         | —                |

Reproduce: `bun install && bun run bench:sync && bun run bench:tanstack`. Convex
also needs a deploy key (see `CONVEX.md`).

## How to read this

**Sequential throughput is latency-bound.** One write is in flight at a time, so
writes/sec ≈ 1,000 / mean_ms. The in-process engine (no transport at all)
sustains ~50,000 mutations/sec — see the sync repo's `bench/run.ts`. These
numbers are the real client-perceived round-trip.

**The Convex row is a different deployment.** Convex is a hosted backend, so
every write is a public-internet round-trip to their datacenter — that explains
~50 ms out of its ~55 ms mean. Self-hosted Convex on the same machine would
shrink that gap; that comparison is heavier to set up and was out of scope here.

**TanStack DB is a client store + sync coordinator,** not itself a sync engine.
The number above is its `queryCollection` over a small local Elysia REST server
— the same workload (`POST /counter/bump`), so the comparison is honest. It
includes TanStack's transaction/optimistic overhead on top of the HTTP
round-trip. (TanStack DB also pairs with Electric/sync engines via other
collection types; that's a different deployment again.)

**Zero is the closest architectural rival** (its own Postgres, push diffs over
WS). `zero-cache` itself runs end-to-end here (replicates the `counters` table,
listens on :4848); the v1.5 client API for writes moved to **custom mutators**
that need a separate push HTTP server. The schema/mutators/client are
scaffolded — see `ZERO.md` for the finishing setup.

## Methodology

- Single client, sequential, awaited writes.
- Warm-up before measurement (sync 100, others 25–50).
- Measured count: sync 2,000, others 500 (more is cheap locally; capped for
  cloud to avoid Convex usage).
- Round-trip = client issues mutation → server-confirmed acknowledgement.
- Full distribution (min/p50/p95/p99/mean/max) reported in script output.
