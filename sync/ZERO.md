# Running the Zero comparison

Zero ([Rocicorp](https://zero.rocicorp.dev)) syncs your Postgres to clients via a
`zero-cache` process. It runs locally, so it's the closest apples-to-apples
latency comparison to `@absolutejs/sync`. It needs a Postgres with **logical
replication** and the `zero-cache` server.

## 1. Postgres with logical replication (Docker)

```bash
docker run -d --name sync-bench-pg -p 54330:5432 \
  -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=zbench \
  postgres:16 -c wal_level=logical
```

## 2. zero-cache + schema

Zero needs a `schema.ts` (a `counters` table) and `zero-cache` pointed at the
Postgres `ZERO_UPSTREAM_DB`. See `zero/` for the schema + config; start it with
`bunx zero-cache`.

## 3. Run the workload

```bash
bun run scripts/bench-zero.ts   # connects a Zero client, issues N increments
```

> Status: scaffolding pending — Zero's local stack (Postgres + zero-cache +
> permissions) is heavier than the others and was deferred behind the Convex run
> on this memory-constrained box. The workload mirrors `bench-sync.ts`.
