# Results — shared-counter workload

Write round-trip latency (mutation → server ack) and sustained sequential
throughput. See `README.md` for the workload and the (important) condition
caveats — Convex runs in its cloud, the others run locally.

| Backend                | Where        | round-trip p50 | round-trip p95 | writes/sec (seq) |
| ---------------------- | ------------ | -------------- | -------------- | ---------------- |
| **@absolutejs/sync**   | local (WS)   | **0.64 ms**    | **1.43 ms**    | **~1,260**       |
| Zero (`zero-cache`)    | local (WS)   | _pending_      | _pending_      | _pending_        |
| Convex                 | cloud (HTTPS)| _pending_      | _pending_      | _pending_        |

> Sequential throughput is latency-bound (one write in flight): writes/sec ≈
> 1000 / p_mean_ms. The in-process engine (no transport) sustains ~50,000
> mutations/sec — see the sync repo's `bench/run.ts`.

Hardware: WSL2 dev box, Bun 1.3. Reproduce: `bun run bench:sync`.
