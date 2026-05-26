# Results — shared-counter workload

Write round-trip latency (mutation → server ack) and sustained sequential
throughput. See `README.md` for the workload and the (important) condition
caveats — Convex runs in its cloud, the others run locally.

| Backend                | Where               | round-trip p50 | round-trip p95 | writes/sec (seq) |
| ---------------------- | ------------------- | -------------- | -------------- | ---------------- |
| **@absolutejs/sync**   | local (WS)          | **0.64 ms**    | **1.43 ms**    | **~1,260**       |
| Convex                 | cloud, US East (WSS)| 53.4 ms        | 64.3 ms        | ~18              |
| Zero (`zero-cache`)    | local (WS)          | _pending_      | _pending_      | _pending_        |

A sync write is **~83× faster** than a Convex write **in this configuration** —
because Convex is a managed cloud backend, every write is a public-internet
round-trip to their datacenter (~50 ms), while sync runs in your own Elysia
server, so writes never leave the loopback. This is the **deployment-model**
difference, not a "sync is 83× faster than Convex" claim — it's the cost of
adopting a hosted backend when you could keep the data path local. (Convex
co-located with your app would shrink that gap; a true apples-to-apples
comparison would be self-hosted Convex on the same box, which is heavier to set
up and was out of scope here.)

> Sequential throughput is latency-bound (one write in flight): writes/sec ≈
> 1000 / p_mean_ms. The in-process engine (no transport) sustains ~50,000
> mutations/sec — see the sync repo's `bench/run.ts`.

Hardware: WSL2 dev box, Bun 1.3. Reproduce: `bun run bench:sync`.
