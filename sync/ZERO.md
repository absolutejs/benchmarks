# Running the Zero comparison

Zero ([Rocicorp](https://zero.rocicorp.dev)) syncs your Postgres to clients via a
`zero-cache` process. It's the closest architectural rival to `@absolutejs/sync`,
so it's the most useful local-vs-local comparison.

## Current status — partially set up

`zero-cache` itself **does run** end-to-end here:

```bash
docker run -d --name sync-bench-pg -p 54330:5432 \
  -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=zbench \
  postgres:16 -c wal_level=logical -c max_wal_senders=10 -c max_replication_slots=10
docker exec sync-bench-pg psql -U postgres -d zbench \
  -c "create table counters (id text primary key, n bigint not null default 0); insert into counters(id,n) values ('c',0);"

ZERO_UPSTREAM_DB="postgresql://postgres:postgres@localhost:54330/zbench" \
ZERO_REPLICA_FILE="/tmp/zbench-replica.db" \
ZERO_AUTH_SECRET="dev" ZERO_ADMIN_PASSWORD="dev" \
ZERO_SCHEMA_PATH="./zero/schema.ts" \
node ./node_modules/.bin/zero-cache
```

Hits: `zero-dispatcher listening at http://[::]:4848` + replicates `counters`
from Postgres. (After installing `@rocicorp/zero`, `npm rebuild
@rocicorp/zero-sqlite3 --build-from-source` was needed — the bun-pulled native
binary's Node ABI didn't match the system Node.)

## What's deferred

The Zero v1.5 **client** API for writes changed: `z.query`/`z.mutate.table.X` is
deprecated/empty by default — writes go through **custom mutators** registered
on both client and a separate **push HTTP server** that runs them
authoritatively. To produce a measured Zero number with the same workload as
`bench-sync.ts`, the next step is:

1. Add a small Elysia push server that exposes `/zero/push` and runs the
   `counter.bump` mutator against the same Postgres.
2. Update `bench-zero.ts` to use `createMutators` + the push URL.
3. Then `bun run scripts/bench-zero.ts`.

The schema (`zero/schema.ts`) + mutator (`zero/mutators.ts`) + a draft client
bench (`scripts/bench-zero.ts`) are scaffolded.
