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

## On DX parity (the "Convex generates an `api`" thing)

A common follow-up: *"Convex generates a typed `api` object from your
functions — does sync have that?"* Yes, via a different stack:

- Sync ships `hydrateRoute(engine, collection, auth)` + `mutateRoute(engine,
  mutation, auth)` (in `@absolutejs/sync/engine`) that turn engine pieces
  into ordinary Elysia routes with TypeBox schemas.
- Client side: `treaty<typeof app>('localhost:3000')` from `@elysiajs/eden`
  gives a fully-typed client — args and return values flow from the route
  signatures, no codegen step. `syncStore({ hydrate: () => api.x.get(),
  mutate: a => api.y.post(a), diffs: {...} })` then layers optimism,
  reconnect, and offline on top of those Eden calls. Row + result types are
  inferred end-to-end.
- `@elysiajs/openapi` (with Scalar UI) is auto-mounted by `@absolutejs/
  absolute` in dev by default — so `/openapi` is live for every route the
  Elysia app declares, including the sync hydrate/mutate ones, without
  configuration.

The spec lives at [`@absolutejs/sync/docs/eden-typed-sync.md`](https://github.com/absolutejs/sync/blob/main/docs/eden-typed-sync.md).
Equivalent DX to Convex's `api` codegen, different machinery — Eden + TypeBox
do the typing where Convex has its own codegen step. Either way, the call
site is fully typed.

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
| **@absolutejs/sync**   | 2-engine cluster, **PG-NOTIFY bus**, local  | 5.9   | **11.8** | **17.6** | 24.4    | 12.2    |
| Convex                 | self-hosted, loopback Docker                | 13.9  | 19.8     | 28.5     | 36.8    | 20.6    |
| Convex                 | cloud (HTTPS)                               | 60.8  | 69.4     | 86.9     | 105.6   | 72.0    |
| Zero                   | local (zero-cache)                          | —     | —        | —        | —       | —       |

**The shape of the gap:** sync's propagation adds only ~1.5 ms over its own
write-ack roundtrip — fan-out is in-process, the subscriber's WS gets the
diff frame within the same tick. Convex self-hosted (loopback) adds ~4 ms
over its own write-ack: their reactive subscriber notification path is a
second HTTP/WS hop, but it's local. Cloud Convex's ~17 ms over write-ack is
that same hop carrying across the internet.

**Cluster mode** ships a `ClusterBus` seam for horizontal scale; two first-
party rows above measure it. The in-memory bus is the floor (same process,
same tick — same order of magnitude as single-engine). The **PG-NOTIFY bus**
(`@absolutejs/sync-bus-pg`, published v0.0.1) adds **~5–6 ms** for the
actual cross-process NOTIFY round-trip: p50 11.8 ms vs 6.2 ms in-memory,
p95 17.6 ms vs 11.1 ms. That's the real production cost of horizontal scale
without adding Redis to your stack — your existing Postgres carries the
change feed. The 8000-byte NOTIFY payload limit is handled cleanly inside
the bus (small messages inline; oversized batches spill to a
`sync_cluster_spill` table + a vacuum API). Redis or NATS implementations
would land at similar latencies — pick the bus your stack already uses.

Caveat: per-instance version cursors mean a client that reconnects to a
*different* instance falls back to a fresh snapshot (correct, not catch-up
diff). Use sticky sessions if cross-instance reconnect-as-diff matters; or
accept the cold-hydration cost on cross-instance reconnect.

**Zero is unmeasured here, honestly.** v1.5 deprecates the old
`definePermissions` model and points at cookie-based auth; with
`auth: undefined` against a `zero-cache` that has deployed permissions, the
subscriber's materialized view stays at `resultType: 'unknown'` indefinitely
and never receives row data — the mutation still acks and writes to PG. This
is a Zero auth-transition issue, not an engine-latency measurement, so a
fabricated number would be worse than the gap. Re-run after Zero v1.6 / the
cookie-auth migration is a queued item (`scripts/propagation-zero.ts` is in
the repo and ready).

## Wire bandwidth — sync diff frames vs Convex full-result frames

Both engines push updates to subscribers over WebSocket on change. The
**wire format** is the difference: sync's `applyChangeBatch` produces a
`diff` frame with `{ added, removed, changed }` arrays — only the rows that
actually moved. Convex pushes the **whole new query result** on every
change, per their own [GitHub #95](https://github.com/get-convex/convex-backend/issues/95)
and the [object-sync-engine roadmap](https://stack.convex.dev/object-sync-engine)
admission. The bandwidth gap scales with K (rows held by the subscriber).

Workload (`scripts/reactive/wire-bytes-{sync,convex}.ts`): subscribe to a
query holding K rows, wrap the WS to count inbound bytes, fire 25
single-row mutations, divide. Per-write inbound bytes:

| K rows held | sync (diff frame) | Convex (full-result frame) | ratio |
| ----------- | ----------------- | -------------------------- | ----- |
| 100         | **117 B**         | 11,547 B                   | **99×**    |
| 1,000       | **118 B**         | 113,905 B                  | **965×**   |
| 5,000       | **118 B**         | 576,830 B                  | **4,888×** |

Sync stays **flat at ~118 bytes per write regardless of K** — the diff
frame for one changed row is constant. Convex grows **linearly in K**: at
5,000 rows held, every single-row mutation sends ~577 KB to every
subscriber. Multiply that by N subscribers and the bandwidth bill scales as
N × K × per-row-bytes, not N × per-change-bytes. That's the structural
reason Convex's own GitHub issue documents users hitting 1 GB bandwidth in
dev with a 5 MB database.

Hard limits we hit while building the bench, both from Convex's [Limits
docs](https://docs.convex.dev/production/state/limits):

- **Array return values cap at 8,192 entries.** Bench capped at K=5000 to
  stay under. Sync has no equivalent limit (caps are PG-bound, effectively
  unbounded for these sizes).
- **Single-function reads cap at 4,096 rows scanned.** A naïve "delete all
  + reseed" mutation breaches it once the table is over the cap. The
  Convex bench paginates purge + seed into 1,000-row chunks; sync just
  runs `truncate + insert ${rows}`.

What this means for production: a Convex app subscribing to a list with K
rows costs O(N·K) bytes on every write to that list. A sync app costs
O(N·changed_rows). At list-of-5,000 scale the difference is roughly the
same as serving every list page as a JPEG vs as a `Set-Cookie` header.

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

@absolutejs/sync 1.1.0:

| subscribers | tail p50 (ms) | tail p95 (ms) | tail p99 (ms) |
| ----------- | ------------- | ------------- | ------------- |
| 1           | 5.1           | 9.1           | 9.2           |
| 10          | 5.9           | 8.1           | 8.2           |
| 100         | 10.2          | 13.7          | 14.8          |
| 1,000       | **66.2**      | **81.6**      | **81.9**      |

Pre-1.1.0 (the linear O(N) shape this section originally documented):

| subscribers | tail p50 (ms) | tail p95 (ms) | tail p99 (ms) |
| ----------- | ------------- | ------------- | ------------- |
| 1           | 7.3           | 11.2          | 12.2          |
| 10          | 28.2          | 32.8          | 37.3          |
| 100         | 161.4         | 189.6         | 189.9         |
| 1,000       | 1,645.3       | 2,461.5       | 2,647.1       |

**Shape changed from linear O(N) to near-constant.** Sync 1.1 dedupes
reactive query reruns per change batch keyed by `(collection, params,
ctx)` — subscribers sharing equivalent inputs share a single rerun. At
1k subs the tail dropped **20–25×**; what's left at 1k is per-WS-frame
write cost, the focus of the next item (#22 batch-frame fan-out). The
1k row is still ~66 ms because the engine still writes 1,000 WS frames
serially after the shared rerun completes; batched frames + parallel
writes will close the rest. Different `ctx` references still produce
independent reruns (per-user query bodies stay isolated — correctness
tested). The current
engine fans out serially over each WS connection. Closing this is a real
engine task: per-query diff sharing (compute the change once for every
subscriber on the same query+params), parallel WS frame writes, and
backpressure-aware batching. Cluster mode + a real bus would let you spread
this across processes but each process still hits the same per-process ceiling.

### 1b. Subscribe-storm (`subscribe-storm.ts`, sync 1.3+ cache)

Where 1a measures fan-out cost (one write → N subscribers), this measures
the **subscribe** path: N fresh subscribers to the same query connect
simultaneously, do any of them actually hit the DB? Convex coalesces
queries across all online clients ("every specific combination of
(query code, parameters, database read set) executes only once"). Sync
1.1 deduped reactive reruns within a single write batch; 1.3 lifts that
across batches via a cross-client query result cache.

| N subscribers | cache=on ready (ms) | cache=on DB hits | cache=off ready (ms) | cache=off DB hits | speedup |
| ------------- | ------------------- | ---------------- | -------------------- | ----------------- | --------- |
| 1             | 56                  | 1                | 53                   | 1                 | warmup    |
| 10            | 54                  | **0**            | 103                  | 10                | DB: 10→0  |
| 100           | 151                 | **0**            | 229                  | 100               | DB: 100→0 |
| 1,000         | 830                 | **0**            | 1,437                | 1,000             | DB: 1k→0  |

Wall-clock improvement is ~1.5–1.9× because each subscriber still pays
the per-WS handshake + snapshot frame transport cost. The DB-side cost
is what matters at scale: at 1k subs we went from 1,000 PG queries to 1.
Cache entries are invalidated when a write overlaps the read set; the
batch's rerun then refreshes the cache so the *next* subscriber after a
write is still a hit. Different `ctx` references stay isolated (per-user
query bodies are unaffected).

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

### 3. Reconnect-after-offline (`reconnect-replay.ts`) — catch-up via `since`

The SAME subscriber stays open across iterations; its `appliedVersion`
survives `disconnect()` (new in `@absolutejs/sync` 1.2). Each iteration
disconnects, fires K writes while offline, then auto-reconnect fires and
the subscribe carries `since: appliedVersion`. The engine replies with a
catch-up diff (or a snapshot if the change log can't cover the gap).
Measurement excludes the artificial `reconnectMs` backoff — we time from
"WS starts reopening (`status: connecting`)" to "subscriber is up to date."

| missed writes | catch-up p50 (ms) | p95 (ms) | max (ms) |
| ------------- | ----------------- | -------- | -------- |
| 1             | 3.6               | 5.5      | 6.3      |
| 10            | 6.2               | 7.0      | 7.8      |
| 100           | 4.2               | 4.4      | 4.4      |

Catch-up is **bounded** and **independent of missed-writes count** —
~4–6 ms is essentially "WS handshake + subscribe + one diff frame back."
The engine builds one diff covering the change log's `(since, now]`
window and sends it as a single frame; K=100 isn't materially slower than
K=1. This is the path that makes the local-first promise real: a tab
that's been backgrounded for an hour reconnects in milliseconds, not by
re-downloading the workspace.

**Earlier draft of this section was wrong.** The original bench created
a fresh `createSyncCollection` per iteration, so each "reconnect" was
actually a cold subscribe with no `since` — and the engine sent a full
snapshot. The numbers we reported (5.5/7.0/5.4 ms) were cold-hydration
on the 1-row test table, not catch-up. With a 100k-row table the
fresh-client path would have been ~880 ms regardless of how many writes
were missed; the `disconnect()`-based path here stays ~5 ms because it
ships a diff, not a snapshot. Resume-via-`since` was already shipped on
both sides; `disconnect()` was just the missing client trigger to
exercise it cleanly from tests/benches/apps.

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
push-down + delta maintenance) — measured next.

### 4b. Ranged subscriptions via `defineGraphCollection` (`ranged-subscriptions-graph.ts`)

The same workload as 4, but wired through sync's incremental operator
graph instead of a reactive query. The source's `hydrate` pushes the
filter to SQL (`select ... where assignee = ?`), and incremental
changes are routed through `match` so the graph only sees rows that
belong to this subscriber's view. The `orderBy` operator maintains
a sorted result incrementally.

| rows in table | cold p50 (ms) | cold p95 (ms) | live update p50 (ms) | live update p95 (ms) |
| ------------- | ------------- | ------------- | -------------------- | -------------------- |
| 1,000         | 14.5          | 18.2          | **10.5**             | 16.1                 |
| 10,000        | 34.4          | 40.0          | **16.6**             | 21.7                 |
| 100,000       | 116.0         | 123.9         | **41.8**             | 54.4                 |

**This kills the O(table size) cliff.** Direct comparison vs 4:

| rows    | cold (reactive) | cold (graph) | speedup | live (reactive) | live (graph) | speedup    |
| ------- | --------------- | ------------ | ------- | --------------- | ------------ | ---------- |
| 1,000   | 11.1            | 14.5         | ~same   | 21.8            | 10.5         | 2.1×       |
| 10,000  | 42.9            | 34.4         | 1.25×   | 72.5            | 16.6         | 4.4×       |
| 100,000 | 313.4           | 116.0        | 2.7×    | 577.9           | **41.8**     | **13.8×**  |

At 100k rows, live-update latency goes from ~580 ms (default reactive
query) to ~42 ms — and that 42 ms is essentially "WS round-trip + the
PG `update` + diff frame to the subscriber"; the rest of the 100k-row
table is untouched because the operator graph only routes the single
changed row through this subscriber's pipeline. The cliff is **not**
an engine ceiling; it's a default-path cost. For ranged queries over
big tables, `defineGraphCollection` is the recommended pattern.

### 5. Multi-row transaction throughput (`multi-row-tx.ts`)

The shared-counter bench writes one row per commit. Real workloads commit
many. This measures sequential awaited commits at varying batch sizes,
with one subscriber attached so fan-out is a real cost. The mutation
handler emits one `actions.change` per row inside one mutation, so the
engine commits all of them as one `applyChangeBatch` and the subscriber
receives a single net-merged `diff` frame with all rows in `added`.

| rows / commit | commits/sec | rows/sec |
| ------------- | ----------- | -------- |
| 1             | 62          | 62       |
| 10            | 49          | 490      |
| 100           | 26          | 2,648    |
| 1,000         | 6           | 6,111    |

The ceiling here is **PG transaction commit time**, not engine fan-out.
At batch=1000 each commit takes ~165 ms — dominated by the `insert into
... values (...) ... (1000 rows)` planning + fsync. The engine's
contribution per commit is a single net-merged diff per subscription
(`applyChangeBatch` merges N row diffs into one via `mergeViewDiffs`)
plus one WS `diff` frame per connection. An earlier draft of this
section blamed fan-out for the drop at batch=1000 — measurement was
mis-shaped: the writer was returning only 1-of-N rows to the engine,
so the engine fanned out one row, not a thousand. Corrected mutation
handler now emits all N changes, and the numbers barely moved (5 → 6
commits/sec) — confirming PG, not fan-out, was the ceiling all along.

### What this section shows

Sync's strong floor numbers (write round-trip, propagation) hold under the
"counter" workload — but the engine has clear scaling cliffs at the things
real apps grow into:

- **Subscription fan-out** — **fixed in 1.1.0**. The original O(N) rerun-
  per-subscriber path was the headline weakness from the 1.0 bench
  (~1.6 s tail at 1k subs). 1.1.0 dedupes reactive query reruns per change
  batch keyed by `(collection, params, ctx)`, dropping tail latency
  20–25× at 1k subs (now ~66 ms p50). What's left at 1k subs is the
  irreducible cost of N synchronous `ws.send` calls to N different
  sockets (microseconds × 1000 ≈ tens of ms). Bun's WS API is
  synchronous so there's no parallelism to gain via `Promise.all`; the
  per-frame work is already minimal.
- **Reactive query re-runs are O(table size)** when the query body calls
  `ctx.db.all` and filters client-side — BUT this is a default-path cost,
  not an engine ceiling. The graph-collection variant
  (`scripts/reactive/ranged-subscriptions-graph.ts`, or
  `bun run reactive:ranged-graph`) drops live-update latency at 100k rows
  from ~580 ms to ~42 ms (13.8×) by pushing the filter to SQL and routing
  incremental changes through an operator graph. `defineGraphCollection`
  is the recommended pattern for ranged queries over big tables.
- **Reconnect catch-up via `since`** — **already shipped; surfaced in 1.2
  via `disconnect()`**. The change log + `canResume` + catch-up diff
  builder were always there server-side, and the client tracked
  `appliedVersion` since before 1.0; missing was a client-side trigger
  for an offline blip. The original "reconnect = cold hydration" finding
  was a bench mismeasurement (fresh client per iteration, no `since`).
  Catch-up is now ~4–6 ms regardless of missed-writes count (would have
  been ~880 ms cold-hydration at 100k rows in the original shape).
- **Multi-row fan-out** — investigated, no engine fix needed. The engine
  already net-merges N row changes into one diff per subscription
  (`applyChangeBatch` + `mergeViewDiffs`) and one WS frame per connection;
  the multi-row-tx ceiling is PG transaction commit time, not engine
  fan-out (the bench was originally mis-shaped — see section 5).

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

## Sandbox-backend bench — `sandboxedHandler` (Worker vs FFI)

`sync.sandboxedHandler` runs a string-form mutation inside an `@absolutejs/isolated-jsc` Isolate so untrusted handlers (multi-tenant PaaS, plugin systems, AI-generated logic) can't reach the host. isolated-jsc ships two backends:

- **Worker**: one Bun Worker per isolate → its own JSC VM. Calls cross via postMessage.
- **FFI**: direct `bun:ffi` calls into `libJavaScriptCore`. No Worker, no IPC.

`@absolutejs/sync@1.7.1` defaults `sandbox: { backend: 'auto' }`, which picks FFI when libJSC is reachable and Worker otherwise. This bench measures the trade-off so users can decide whether to pin one explicitly.

Same hardware as the rest of this file (WSL2, Bun 1.3.14). Each bench creates a fresh sync engine and runs the lane to completion. Warmup 8 calls, measured 500 calls for Lanes 1–2.

| Lane                                     | Backend    | cold (ms) | warm p50 (ms) | warm p95 (ms) | warm mean (ms) | ops/sec |
| ---------------------------------------- | ---------- | --------- | ------------- | ------------- | -------------- | ------- |
| Pure handler — `(args) => args.n * 2`    | **worker** | 35        | **0.94**      | 4.31          | **1.34**       | **745** |
| Pure handler — `(args) => args.n * 2`    | ffi        | **22**    | 4.69          | 7.54          | 5.08           | 197     |
| `actions.change` (async Reference)       | **worker** | 43        | **0.94**      | 4.64          | **1.33**       | **751** |
| `actions.change` (async Reference)       | ffi        | **10**    | 6.62          | 10.91         | 7.16           | 140     |

**20-tenant cold spawn** (one mutation per tenant, each compiled + spawned + first-called sequentially — the multi-tenant scenario where FFI's small cold heap matters):

| Backend    | total cold (ms) | per-tenant (ms) | RSS Δ (MB) |
| ---------- | --------------- | --------------- | ---------- |
| worker     | 568             | 28.4            | 19         |
| **ffi**    | **126**         | **6.3**         | 19         |

Reproduce: `bun run bench:sandbox`.

### What's driving each row

**Worker wins warm dispatch (~5–7×) because postMessage to a long-lived worker is cheap.** Once the isolate exists, the per-call work is one structured-clone of `args/ctx`, one postMessage with the wrapped script, and one return clone — round-tripped through libuv. The Bun-Worker hot path is well-optimised.

**FFI loses warm dispatch because every call is synchronous FFI work on the hot path:** create a fresh context (`JSGlobalContextCreateInGroup`), install four `actions.*` References as `JSCallback`s + four `JSObjectSetProperty` calls, evaluate the wrapped script (`JSEvaluateScript`), then run `unwrapResultPromise` (a setup eval + a read eval). That adds up to ~4–7 ms per call — far more than Worker's ~1 ms postMessage round-trip.

**FFI wins cold spawn (~4.5×) because there's no Worker spawn.** Bun's Worker bootstrap (load Bun runtime, parse worker.ts, wire postMessage) is ~25 ms per isolate. FFI's first-call cost is `JSContextGroupCreate` + `JSGlobalContextCreateInGroup` + script compile — ~6 ms. For a 20-tenant burst this is 568 ms → 126 ms.

**`actions.change` works on FFI now (this is the 0.4 fix).** Pre-0.4, the async Reference would throw "Promise that doesn't settle synchronously"; 0.4 added a pump loop (alternate Bun-event-loop yield + JSC microtask drain, bounded by `Script.run`'s `timeout`). The ~6.6 ms FFI p50 is the pump cost (one `setTimeout(0)` + one no-op eval per await).

**RSS deltas tie at 19 MB** — both backends end up holding similar process-wide memory after the 20-tenant burst, with the difference dominated by JIT'd code rather than per-isolate cold heap. The per-isolate _cold heap_ gap (~46 MB worker vs ~300 KB FFI, documented in isolated-jsc) shows up under millions of isolates or under JSC heap profiling, not at this RSS granularity.

### When to pin which

- **Default (`'auto'` → FFI on Linux/macOS)**: best for **bursty multi-tenant** workloads (PaaS per-tenant code, per-user AI-generated logic) where cold spawn dominates and any single isolate sees few calls.
- **Pin to `'worker'`**: best for **hot-path single-tenant** workloads where one or two sandboxed mutations get hammered. Also required if your handler needs Web APIs (`URL`, `TextEncoder`, `WebSocket`) — those live in the Bun-Worker environment, not the bare JSC C API.
- **Pin to `'ffi'`**: best for **read-only handlers** (compute a value from `args`/`ctx`, return it, no `actions.*` calls) — gets the ~300 KB cold heap + interrupt-driven CPU timeouts (the isolate survives a `TimeoutError` instead of dying). Skips the multi-tenant Worker-spawn tax even when you only have one tenant.

### Caveats

- Cold-start numbers across lanes in the same process aren't directly comparable — by Lane 2 the Bun runtime + JSC JIT are warm from Lane 1. Use the dedicated 20-tenant spawn lane for clean cold-start comparisons.
- Bun Worker cold start scales linearly per isolate (no fork-copy). On a real PaaS where tenants compile their own mutations, the gap widens with tenant count.
- The pump cost on FFI for async References is per-`await`, not per-call. A handler that awaits five `actions.change` calls will pay ~5× the pump cost; a handler that awaits one will pay ~1×.
