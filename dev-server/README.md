# dev-server benchmarks

How long `absolute dev` makes a developer wait, measured on a real app.

Three moments, because they are not the same moment:

| | what it means |
| --- | --- |
| **first byte** | the port answers at all. With the early listener that is a `503` building page, which is what stops the browser showing "connection refused". |
| **ready** | the framework printed its ready banner. The server is up; on a lazy dev build the page you asked for may still need building. |
| **first page** | a real response, not a `503`. This is "how long until I can work". |

## Run it

```bash
bun install

# both cold and warm, three runs each
bun run bench --app ~/apps/dealroom

# one specific shape
bun run bench --app ~/apps/dealroom --runs 5 --mode cold

# against a framework checkout instead of the app's installed copy
bun run bench --app ~/apps/dealroom --framework ~/abs/absolutejs

# with a flag under test, labelled for the report
bun run bench --app ~/apps/dealroom --env ABSOLUTE_DEV_EAGER=1 --label eager
```

`--mode cold` deletes the app's `build/` and `.absolutejs/` first, so it
measures a first-ever boot. `--mode warm` keeps them, which is what a restart
during a working day actually looks like. Warm is usually the number you
care about; cold is the one that regresses silently.

## Compare two things

This is the one to reach for, because a single run proves nothing:

```bash
# a feature flag
bun run compare --app ~/apps/dealroom \
  --a-env ABSOLUTE_DEV_PRESCAN=0 --b-env ABSOLUTE_DEV_PRESCAN=1 --runs 4

# two framework checkouts
bun run compare --app ~/apps/dealroom \
  --a-framework ~/abs/absolutejs-main --a-label main \
  --b-framework ~/abs/absolutejs --b-label branch --runs 4
```

It alternates A/B/A/B rather than running all of A then all of B, and it
will tell you "tie" when the two are not separable. See
[`METHODOLOGY.md`](./METHODOLOGY.md) for why both of those matter more than
they sound.

## Read the history

Every run appends to `results/runs.jsonl` with its load average.

```bash
bun run report
bun run report --label eager
```

## Flags

| flag | default | meaning |
| --- | --- | --- |
| `--app <path>` | required | the AbsoluteJS app to boot |
| `--runs <n>` | `3` | boots per mode, or per side when comparing |
| `--mode cold\|warm\|both` | `both` | `compare` defaults to `warm` |
| `--framework <path>` | app's installed copy | copies that checkout's `dist` into the app |
| `--env K=V` | none | repeatable; passed to the dev process |
| `--label <name>` | `run` | groups runs in `report` |
| `--path <url path>` | `/` | the page to request |
| `--port <n>` | `47800` | |
| `--timeout <ms>` | `600000` | give up on one boot |

## Notes

One boot at a time, machine-wide: a large app peaks around 5 GB, and two at
once swap the machine and produce numbers that look like a regression. The
lock is a file, so it holds across shells and across people.

If a run reports that the port answered but no page arrived, the app is
probably missing environment it needs to boot — a database URL, an API key.
The benchmark prints the tail of the dev server's output so you can see which.
