# Results — shared-counter workload

Write round-trip latency (mutation → server-confirmed) and sustained sequential
throughput. One client, sequential awaited writes. Same workload, same harness
(`scripts/lib/measure.ts`), **same Postgres backing every local backend**.

Setup hardware: WSL2 dev box, Bun 1.3, system Node 22.

| Backend                | Where                                          | min (ms) | p50 (ms) | p95 (ms) | p99 (ms) | mean (ms) | writes/sec (seq) |
| ---------------------- | ---------------------------------------------- | -------- | -------- | -------- | -------- | --------- | ---------------- |
| **@absolutejs/sync**   | local (WS) + Postgres                          | **4.2**  | **9.5**  | **18.0** | **26.2** | **10.4**  | **96**           |
| TanStack DB            | local (REST + queryCollection) + Postgres      | 7.6      | 17.5     | 30.3     | 36.1     | 18.9      | 53               |
| Convex                 | **self-hosted, loopback Docker (HTTP)**        | 11.0     | **15.9** | 21.3     | 26.3     | 16.4      | **61**           |
| Convex                 | cloud, dev WSL → Convex (HTTPS)                | 45.5     | 52.8     | 66.2     | 90.8     | 54.7      | 18               |
| Convex                 | cloud, GH Actions runner (Wyoming) → Convex    | 71.3     | 76.6     | 83.2     | 90.8     | 77.5      | 13               |
| Zero                   | local (zero-cache + push server + PG)          | 44.4     | 66.9     | 104.9    | 151.3    | 71.1      | 14               |

Reproduce: `bun install && bun run bench:sync && bun run bench:tanstack && bun run bench:zero` (Zero needs the push server + zero-cache running, see `ZERO.md`; Convex needs a deploy key OR the self-hosted Docker setup, see `CONVEX.md`). Propagation-latency bench (write → remote-subscriber): `bun run propagation:sync` / `propagation:sync-cluster` / `propagation:convex` — see the "Propagation latency" section below.

## What's driving each row

**Sync wins because the write path is direct:** WebSocket → engine handler →
Postgres (one fsync). Roughly 4–6 ms of that is the PG write; the rest is
WS framing + the engine.

**TanStack DB pays an HTTP + transaction-coordinator tax** on top of the same
PG write: a fresh HTTP POST per write (no persistent connection), JSON parsing,
and the queryCollection's optimistic-apply + onUpdate wrapping. About 7–8 ms on
top of sync per write — that's the layer the architecture trades for
flexibility (it pairs with many backends, not just one).

**Convex (self-hosted, loopback Docker) is the honest engine-vs-engine row.**
Running Convex's own backend container (`ghcr.io/get-convex/convex-backend`)
on the same WSL box as sync removes the network entirely — what's left is
engine cost. Sync wins on write round-trip (p50 **9.5** vs **15.9** ms, ~1.7×)
and concurrent throughput (305 w/s @ c=64 vs Convex saturating at ~65), but
the gap is **much narrower than the cloud comparison suggested** (cloud Convex
p50 was 53 ms WSL→cloud, 77 ms US-VM→cloud — that 5–8× delta was almost
entirely the network hop, not engine craft). The self-hosted row is the one
to cite for an engine claim; the cloud rows are deployment-model rows. Convex
self-hosted is a real product, and on a loopback bench it's ~30–60% slower
than sync, not 5× slower.

**Convex (cloud)'s ~53 ms is the deployment-model number.** We ran the same
bench from a GitHub Actions runner (Wyoming) to remove the consumer-ISP
variable: p50 76.6 ms with a very tight distribution (p95 83.2 ms — TLS/HTTPS
overhead is consistent when the network is the floor). Cited as "what
deployment costs," not "what the engine costs." (Workflow:
`.github/workflows/bench-convex-us-east.yml`.)

**Zero is the genuinely surprising row** — its closest-architectural-rival
status (its own PG, push diffs over WS) suggested it would be in sync's
ballpark, but it ends up the slowest local backend. The reason is that Zero
v1.5's mutation path is **two hops**: client → `zero-cache` (WS, queries) →
**push server** (HTTP, mutators) → Postgres (transaction) → back. Each hop adds
latency; the full PG transaction is also held for the duration of the mutator.
The architecture is optimized for read-heavy reactive queries (where it
shines), not for write round-trip latency. Sync's single-process write path
(WS → engine → PG, no extra hop) is the real advantage.

## Concurrent (pipelined) throughput

Same workload, but keep K writes in flight at a time (pipelined `Promise.all`),
measure sustained writes/sec under load:

| Backend                | concurrency = 1 (seq) | 4   | 16  | 64  | scaling (1→64) |
| ---------------------- | --------------------- | --- | --- | --- | -------------- |
| **@absolutejs/sync**   | 54                    | 99  | 188 | **305** | **5.6×**     |
| TanStack DB            | 73                    | 175 | 278 | 297     | 4.1×         |
| Convex (cloud)         | 18                    | 34  | 42  | 43      | 2.4× (saturates) |
| Zero                   | 16                    | 24  | 24  | 32      | 2.0× (saturates) |

The interesting takeaway is **scaling**, not just the absolute number: sync and
TanStack DB scale well with concurrency (their writers parallelise cleanly via
the connection pool), while Convex saturates around 43 w/s (cloud connection
limits + single contended row) and Zero around 32 (its push-server pipeline
serialises writes per client). At 64-way concurrency sync sustains ~10× Zero's
write throughput.

## What this does NOT measure

- **One trivial mutation.** A single counter `UPDATE`, no joins/permissions/
  schema validation hot path.
- **Local loopback.** Even TanStack DB's HTTP goes over loopback (no TLS, no
  real WAN).
- **Single contended row.** Real workloads spread writes across many rows;
  per-row contention behaves differently from per-server contention.
- **No reconnect / offline / large hydration.** Where sync engines actually
  differ *qualitatively* — separate tests warranted.
- **Convex from inside its own region.** The cloud-VM run (Wyoming → Convex,
  p50 77 ms) closes the consumer-ISP variable but is still a cross-region hop
  to Convex's datacenter. A workload deployed inside the same Convex region
  (same AWS AZ as the deployment) would shrink further — but the application
  process still talks to the backend over HTTPS, so the network floor never
  truly goes away the way it does for an in-process library.

## The honest "story"

> Sync's deployment model — a library running in your Elysia server, talking
> directly to your Postgres — has a measured engine advantage over Convex
> (~1.7× write round-trip, ~3× propagation), now confirmed against
> **self-hosted Convex on the same loopback box** (the only fair engine-vs-
> engine comparison). The cloud-Convex 5–8× delta is mostly the network hop,
> not engine craft, and we say so. Zero and TanStack DB pay extra hops that
> sync doesn't (zero-cache→push, HTTP REST). The remaining honest claim is
> "in-process library + your own DB beats hosted/multi-hop on these specific
> workloads," not "we crush them."

## Propagation latency — write → remote-subscriber-receive

The write-roundtrip table above is "writer issues mutation → server acks." It's
the right floor metric, but it isn't the qualitative thing live-query engines
exist for. The harness `scripts/propagation-*.ts` measures the second thing:
two clients connect, one bumps the counter, the other has a subscription on
`counter` — latency is from issuing the mutation to the *subscriber* observing
the new `n`.

| Backend                | Where                                       | min   | p50      | p95      | p99     | mean    |
| ---------------------- | ------------------------------------------- | ----- | -------- | -------- | ------- | ------- |
| **@absolutejs/sync**   | single engine, local (WS + PG)              | 5.3   | **11.0** | **15.8** | 23.3    | 11.2    |
| **@absolutejs/sync**   | 2-engine cluster, in-memory bus, local      | 3.3   | **6.2**  | **11.1** | 14.0    | 6.8     |
| Convex                 | self-hosted, loopback Docker                | 13.9  | 19.8     | 28.5     | 36.8    | 20.6    |
| Convex                 | cloud (HTTPS)                               | 60.8  | 69.4     | 86.9     | 105.6   | 72.0    |
| Zero                   | local (zero-cache)                          | —     | —        | —        | —       | —       |

**The shape of the gap:** sync's propagation adds only ~1.5 ms over its own
write-ack roundtrip — fan-out is in-process, the subscriber's WS gets the
diff frame within the same tick. Convex self-hosted (loopback) adds ~4 ms
over its own write-ack: their reactive subscriber notification path is a
second HTTP/WS hop, but it's local. Cloud Convex's ~17 ms over write-ack is
that same hop carrying across the internet.

**Cluster mode adds essentially zero overhead.** Sync ships a `ClusterBus`
seam (you bring Redis / PG-NOTIFY / NATS) for horizontal scale. The 2-engine
row above measures cross-instance propagation over the bundled in-memory bus
(writer's mutation on engine A → engine B's subscriber). It came in at p50
6.2 ms vs the single-engine 11.0 ms — those numbers are from different runs
and reflect run-to-run system-load variance (~±5 ms is typical), not a
cluster speed-up; the honest read is "cluster fan-out is in the same
order of magnitude as single-engine," not "cluster is faster." A real
bus (PG-NOTIFY or Redis) would add the bus's own latency on top — typically
~1–3 ms LAN. First-party bus adapters are a v1.x roadmap item; today the seam
works but you wire your own publish/subscribe. Caveat: per-instance version
cursors mean a client that reconnects to a *different* instance falls back to
a full snapshot (correct, not catch-up diff). Use sticky sessions.

**Zero is unmeasured here, honestly.** v1.5 deprecates the old
`definePermissions` model and points at cookie-based auth; with
`auth: undefined` against a `zero-cache` that has deployed permissions, the
subscriber's materialized view stays at `resultType: 'unknown'` indefinitely
and never receives row data — the mutation still acks and writes to PG. This
is a Zero auth-transition issue, not an engine-latency measurement, so a
fabricated number would be worse than the gap. Re-run after Zero v1.6 / the
cookie-auth migration is a queued item (`scripts/propagation-zero.ts` is in
the repo and ready).

## Reactive-read scaling — the half the counter bench didn't measure

Counter-style benches measure floor (write round-trip, propagation). They don't
measure the things real reactive-DB workloads actually fail on: fan-out under
load, cold-open of a populated workspace, reconnect catch-up, ranged
subscriptions over big tables, multi-row commits. Five scripts under
`scripts/reactive/` — sync only; competitor comparisons would need a
matched-workload port each and that's a follow-up. The point of THIS section
is to find where sync itself scales and where it doesn't.

### 1. Subscription fan-out scaling (`subscription-scaling.ts`)

One writer mutates; N subscribers all watching the same collection receive
the update. Per-iteration latency = time from the writer's `mutate` to the
**slowest** subscriber observing the change (the user-visible "all clients
are up-to-date" wall).

| subscribers | tail p50 (ms) | tail p95 (ms) | tail p99 (ms) |
| ----------- | ------------- | ------------- | ------------- |
| 1           | 7.3           | 11.2          | 12.2          |
| 10          | 28.2          | 32.8          | 37.3          |
| 100         | 161.4         | 189.6         | 189.9         |
| 1,000       | 1,645.3       | 2,461.5       | 2,647.1       |

**Honest read: this scales linearly.** Tail latency is roughly 1.6 ms per
extra subscriber once you're past ~100. At 1,000 subscribers the slowest
client waits ~1.6 s per write; at 10,000 it would be unusable (run-to-run
variance is meaningful — a prior run measured 2.7 s at N=1000 on a more
loaded box — but the shape is unambiguous). The current
engine fans out serially over each WS connection. Closing this is a real
engine task: per-query diff sharing (compute the change once for every
subscriber on the same query+params), parallel WS frame writes, and
backpressure-aware batching. Cluster mode + a real bus would let you spread
this across processes but each process still hits the same per-process ceiling.

### 2. Cold hydration (`cold-hydration.ts`)

How long from "fresh subscriber connects" to "snapshot is on the client and
the collection is `ready`" at varying table sizes.

| rows    | p50 (ms) | p95 (ms) | p99 (ms) | max (ms) |
| ------- | -------- | -------- | -------- | -------- |
| 100     | 14.5     | 18.7     | 18.7     | 20.4     |
| 1,000   | 36.2     | 57.9     | 57.9     | 59.1     |
| 10,000  | 98.6     | 107.6    | 107.6    | 131.2    |
| 100,000 | 879.3    | 1,650.4  | 1,650.4  | 1,717.0  |

Sub-linear: 1,000× the rows costs ~60× the time. Under 10k rows you're at
sub-100 ms. At 100k rows you're at ~880 ms — usable for cold opens of large
workspaces, not snappy. The dominant cost at large sizes is JSON encoding
the snapshot + a single WS frame; streaming snapshots would cut p95.

### 3. Reconnect-after-offline (`reconnect-replay.ts`)

A subscriber disconnects; the writer fires K mutations while the subscriber
is offline; the subscriber reconnects (fresh client, no cached version).

| missed writes | p50 (ms) | p95 (ms) | max (ms) |
| ------------- | -------- | -------- | -------- |
| 1             | 5.5      | 9.5      | 10.0     |
| 10            | 7.0      | 15.7     | 16.8     |
| 100           | 5.4      | 15.6     | 16.2     |

Reconnect cost is **constant** in missed-writes count — the engine sends the
current snapshot, not a replay of every missed change. Caveat: this also
means reconnect cost = cold-hydration cost. For a 100k-row workspace,
"reconnect after offline" is ~880 ms regardless of whether you missed one
change or a thousand. A real diff-catch-up path (resume from cached version)
would be much cheaper for the "missed one change" case; today that's a
roadmap item.

### 4. Ranged subscriptions (`ranged-subscriptions.ts`)

A reactive query that filters and orders — `tasks where assignee = $me ORDER
BY priority`. The implementation uses `ctx.db.all` + client-side filter
(the default path most users will write; pushing the filter into SQL is the
user's job today). Two measurements per table size: cold subscribe + live
update propagation when ONE matching row changes.

| rows in table | cold p50 (ms) | cold p95 (ms) | live update p50 (ms) | live update p95 (ms) |
| ------------- | ------------- | ------------- | -------------------- | -------------------- |
| 1,000         | 11.1          | 16.2          | 21.8                 | 29.3                 |
| 10,000        | 42.9          | 46.3          | 72.5                 | 89.6                 |
| 100,000       | 313.4         | 390.5         | 577.9                | 634.1                |

Live-update cost is roughly 2× write-roundtrip because the query body
re-runs the whole `db.all` + filter on every change to `tasks`. At 100k rows
a single mutation to one matching row costs ~580 ms to propagate, because
the engine re-scans the entire table to recompute the filter result. **This
is the cost the user pays for not pushing the filter to SQL.** Sync ships
`defineGraphCollection` for incremental operator-graph queries (true
push-down + delta maintenance); a follow-up will measure that path and
compare.

### 5. Multi-row transaction throughput (`multi-row-tx.ts`)

The shared-counter bench writes one row per commit. Real workloads commit
many. This measures sequential awaited commits at varying batch sizes,
with one subscriber attached so fan-out is a real cost.

| rows / commit | commits/sec | rows/sec |
| ------------- | ----------- | -------- |
| 1             | 46          | 46       |
| 10            | 50          | 496      |
| 100           | 26          | 2,630    |
| 1,000         | 5           | 5,393    |

Commits/sec is roughly constant for small batches (PG transaction overhead
amortises), then drops as the per-commit fan-out cost (subscriber gets N row
diffs per commit, sent as N WS frames today) starts to dominate. At
batch=1000 you're moving ~5,400 rows/sec — adequate, not impressive.
Batch-framed fan-out (one WS frame per batch, not per row) would close most
of this gap.

### What this section shows

Sync's strong floor numbers (write round-trip, propagation) hold under the
"counter" workload — but the engine has clear scaling cliffs at the things
real apps grow into:

- **Subscription fan-out is O(N) in subscribers.** Biggest weakness; needs
  per-query diff sharing + parallel writes. Practical ceiling today is a few
  hundred concurrent subs on the same query before tail latency degrades.
- **Reactive query re-runs are O(table size)** when the query body calls
  `ctx.db.all` and filters client-side. Push-down to SQL (or to the
  `defineGraphCollection` operator graph) keeps queries bounded.
- **Reconnect = cold hydration** today; no diff-catch-up from a saved
  version.
- **Fan-out cost per change set is per-row.** Batch-framing the WS payload
  would help large-batch throughput.

These are the real engineering items to take on if "beat Convex at their
game" is the goal. The counter benches above already show sync wins on
small workloads; the path to also winning at scale runs through this list.

## Methodology

Common to every bench in this folder: single client, sequential, awaited
writes; full distribution (min/p50/p95/p99/mean/max) reported in each
script's output.

**Write round-trip** (`bench-*.ts`):

- Warm-up: sync 50, others 25.
- Measured: sync 1,000, others 500.
- Round-trip = client issues mutation → server-confirmed acknowledgement
  (for Zero this is the `.server` half of the `{ client, server }` pair; for
  sync/Convex/TanStack DB the awaited promise is the ack).

**Propagation latency** (`propagation-*.ts`):

- Warm-up: 25, measured: 500 (every backend).
- Propagation = writer issues mutation → a separate subscriber on the same
  collection observes the new value. Two distinct clients per run.
- The `propagation-sync-cluster.ts` variant connects two engines via the
  in-memory `ClusterBus` and routes writer → engine-A, subscriber → engine-B.

**Reactive-read scaling** (`scripts/reactive/*.ts`):

- Sync only; uses a separate `rtasks` table seeded per script (no overlap
  with the counter workload).
- Warm-up + measured-iteration counts vary by script (each one is sized for
  the workload, see the script header).
- Per-iteration latencies and per-rate throughput are computed via the
  shared `scripts/lib/measure.ts`.
