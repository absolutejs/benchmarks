# Results — shared-counter workload

Write round-trip latency (mutation → server-confirmed) and sustained sequential
throughput. One client, sequential awaited writes. Same workload, same harness
(`scripts/lib/measure.ts`), **same Postgres backing every local backend**.

Setup hardware: WSL2 dev box, Bun 1.3, system Node 22.

| Backend                | Where                                          | min (ms) | p50 (ms) | p95 (ms) | p99 (ms) | mean (ms) | writes/sec (seq) |
| ---------------------- | ---------------------------------------------- | -------- | -------- | -------- | -------- | --------- | ---------------- |
| **@absolutejs/sync**   | local (WS) + Postgres                          | **4.2**  | **9.5**  | **18.0** | **26.2** | **10.4**  | **96**           |
| TanStack DB            | local (REST + queryCollection) + Postgres      | 7.6      | 17.5     | 30.3     | 36.1     | 18.9      | 53               |
| Convex                 | cloud, dev WSL → Convex (HTTPS)                | 45.5     | 52.8     | 66.2     | 90.8     | 54.7      | 18               |
| Convex                 | cloud, GH Actions runner (Wyoming) → Convex    | 71.3     | 76.6     | 83.2     | 90.8     | 77.5      | 13               |
| Zero                   | local (zero-cache + push server + PG)          | 44.4     | 66.9     | 104.9    | 151.3    | 71.1      | 14               |

Reproduce: `bun install && bun run bench:sync && bun run bench:tanstack && bun run bench:zero` (Zero needs the push server + zero-cache running, see `ZERO.md`; Convex needs a deploy key, see `CONVEX.md`). Propagation-latency bench (write → remote-subscriber): `bun run propagation:sync` / `propagation:convex` — see the "Propagation latency" section below.

## What's driving each row

**Sync wins because the write path is direct:** WebSocket → engine handler →
Postgres (one fsync). Roughly 4–6 ms of that is the PG write; the rest is
WS framing + the engine.

**TanStack DB pays an HTTP + transaction-coordinator tax** on top of the same
PG write: a fresh HTTP POST per write (no persistent connection), JSON parsing,
and the queryCollection's optimistic-apply + onUpdate wrapping. About 7–8 ms on
top of sync per write — that's the layer the architecture trades for
flexibility (it pairs with many backends, not just one).

**Convex's ~53 ms is almost entirely network.** Every write is a public-internet
round-trip from this WSL box to Convex's region — physics, not engine. We ran
the same bench again from a GitHub Actions runner (a cloud VM in Wyoming) to
remove the consumer-ISP variable: p50 settled at **76.6 ms**, with a very tight
distribution (p95 83.2 ms — TLS/HTTPS overhead is consistent when the network
itself is the bottleneck). Even from a US datacenter, Convex's network-bound
floor sits at ~50–80 ms. The honest framing is "avoiding a hosted-backend hop,"
not "our engine is faster." (Workflow: `.github/workflows/bench-convex-us-east.yml`
on `absolutejs/benchmarks`.)

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
> directly to your Postgres — has a measured write-path advantage over the other
> three. Convex's gap is almost entirely network (it's a hosted backend). Zero
> and TanStack DB pay extra hops (zero-cache→push, HTTP REST) that sync's
> single-process write path doesn't have. That's the real, defensible thesis —
> not "X is N× faster than Y" out of context.

## Propagation latency — write → remote-subscriber-receive

The write-roundtrip table above is "writer issues mutation → server acks." It's
the right floor metric, but it isn't the qualitative thing live-query engines
exist for. The harness `scripts/propagation-*.ts` measures the second thing:
two clients connect, one bumps the counter, the other has a subscription on
`counter` — latency is from issuing the mutation to the *subscriber* observing
the new `n`.

| Backend                | Where                | min   | p50      | p95      | p99     | mean    |
| ---------------------- | -------------------- | ----- | -------- | -------- | ------- | ------- |
| **@absolutejs/sync**   | local (WS + PG)      | 5.3   | **11.0** | **15.8** | 23.3    | 11.2    |
| Convex                 | cloud (HTTPS)        | 60.8  | 69.4     | 86.9     | 105.6   | 72.0    |
| Zero                   | local (zero-cache)   | —     | —        | —        | —       | —       |

**The shape of the gap:** sync's propagation adds only ~1.5 ms over its own
write-ack roundtrip — fan-out is in-process, the subscriber's WS gets the
diff frame within the same tick. Convex's propagation adds ~17 ms over its
write-ack — the recomputed result has to make a second public-internet hop
to push to the subscriber. That's structural to a hosted backend, not a Convex
flaw.

**Zero is unmeasured here, honestly.** v1.5 deprecates the old
`definePermissions` model and points at cookie-based auth; with
`auth: undefined` against a `zero-cache` that has deployed permissions, the
subscriber's materialized view stays at `resultType: 'unknown'` indefinitely
and never receives row data — the mutation still acks and writes to PG. This
is a Zero auth-transition issue, not an engine-latency measurement, so a
fabricated number would be worse than the gap. Re-run after Zero v1.6 / the
cookie-auth migration is a queued item (`scripts/propagation-zero.ts` is in
the repo and ready).

## Methodology

- Single client, sequential, awaited writes.
- Warm-up: sync 50, others 25.
- Measured: sync 1,000, others 500.
- Round-trip = client issues mutation → server-confirmed acknowledgement
  (for Zero this is the `.server` half of the `{ client, server }` pair; for
  sync/Convex/TanStack DB the awaited promise is the ack).
- Full distribution (min/p50/p95/p99/mean/max) in each script's output.
