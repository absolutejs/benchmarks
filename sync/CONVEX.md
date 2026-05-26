# Running the Convex comparison

Convex runs in its cloud, so it needs an account + a deployment. ~5 minutes.

## 1. Sign up + create a project

1. Go to **https://dashboard.convex.dev** and sign up (Google is fine).
2. Create a new project (any name, e.g. `sync-bench`).

## 2. Give me the deploy key + URL

In the project: **Settings → URL & Deploy Key**:

- copy the **Deployment URL** (looks like `https://<name>.convex.cloud`)
- click **Generate a deploy key** (production) and copy it

Paste both back here. I'll set them as env vars — I won't store them anywhere.

## 3. I push the functions and run the bench

```bash
# (me) push convex/schema.ts + convex/counter.ts to your deployment + codegen
CONVEX_DEPLOY_KEY=<key> bunx convex deploy --yes
# (me) run the workload against it
CONVEX_URL=<url> bun run scripts/bench-convex.ts
```

The results land in `RESULTS.md` under the Convex row (labeled "cloud — network").

## Self-hosted Convex (engine-vs-engine, loopback)

The cloud number is network-dominated. To compare engines fairly, run Convex's
own backend in Docker on the same box as sync and re-run the same workload:

```bash
# Start the self-hosted backend (ports 3210 + 3211). Pinned by digest so the
# benchmark stays reproducible — the floating `:latest` tag will drift.
docker run -d --name convex-selfhost \
  -p 3210:3210 -p 3211:3211 \
  -v convex_data:/convex/data \
  ghcr.io/get-convex/convex-backend@sha256:19481d5e9309db4a87a9a2e9d12a6930bd12569e1fc96276d9fa0aae53a106b6

# Mint an admin key
docker exec convex-selfhost bash -c 'cd /convex && ./generate_admin_key.sh'

# Deploy this folder's convex/ functions to the self-hosted backend
# (override CONVEX_DEPLOYMENT so the CLI doesn't use the cloud config)
CONVEX_DEPLOYMENT= bunx convex dev --once \
  --url http://127.0.0.1:3210 \
  --admin-key 'convex-self-hosted|<...>'

# Bench against it
CONVEX_URL=http://127.0.0.1:3210 bun run bench:convex
CONVEX_URL=http://127.0.0.1:3210 bun run propagation:convex
```

Stop / clean: `docker rm -f convex-selfhost && docker volume rm convex_data`.

The self-hosted row in `RESULTS.md` is the honest engine-vs-engine comparison
(both running on loopback, same Bun/WSL2 box).
