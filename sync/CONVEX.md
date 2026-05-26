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
