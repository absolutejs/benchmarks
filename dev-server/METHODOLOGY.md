# Methodology

## What is timed

The clock starts when `bun run dev` is spawned in the app directory and stops
at three points: the first HTTP response of any status, the framework's ready
banner, and the first response that is not a `503`. The dev process gets
`ABSOLUTE_DEV_PROFILE=1`, so the run also captures the build trace under
`<app>/build/.absolute-trace/` and the per-page on-demand build line.

Requests poll every 100ms with a 2s per-request timeout. That granularity is
deliberate: it is far finer than the differences worth acting on, and coarse
enough not to load the machine being measured.

## Why alternating A/B

Boot timings drift. Anything else on the machine — another build, a test
suite, a browser — moves them by tens of percent, and the drift is a slow
ramp rather than random noise, so it does not average out within a run.

Run all of A and then all of B, and that ramp is attributed to B.

This project exists because of that mistake. During the work these numbers
describe, one change was measured twice by two people minutes apart and
"proved" to be both a large win and a large regression. Alternating A/B/A/B
on identical code showed the truth: the two were within noise of each other,
and the change was neutral. Both original conclusions were artifacts of what
else happened to be running.

So: alternate, report the median with the full range beside it, and call a
tie a tie.

## When a difference is real

`compare` reports a difference only when both hold:

1. the medians differ by more than 10%, and
2. the two samples' ranges do not overlap.

The second condition is the one that matters. If A's slowest run is faster
than B's fastest run, something is there. If the ranges interleave, the
medians are decoration — and on a busy machine they interleave constantly.

A tie does not mean the change does nothing. It means this machine, in this
state, cannot separate the two. More runs or a quieter machine may.

## Cold versus warm

**Cold** deletes `build/` and `.absolutejs/` first: no compile cache, no
vendor cache, no previously built pages. It is a first clone, or the first
boot after an upgrade.

**Warm** keeps them, which is what a restart during a working day looks like.

Report both. They regress independently: a change can make the warm path
much faster while quietly making the cold path worse, and only the cold path
is what a new contributor sees.

## Killing the dev server

The `absolute` CLI supervises a `bun --hot` child. Killing the child, or just
freeing the port, makes the parent respawn it — and on a large app that
leaves a multi-gigabyte server running indefinitely. Several of those will
take a machine down.

The harness spawns the dev server in its own process group and kills the
group, parent first. If you are timing something by hand, kill the CLI
process, not the port.

## What is not controlled

The machine. There is no attempt to pin CPUs, drop caches, or quiesce the
system, because the question being answered is "how long does a developer
wait on a normal machine". Every run records its one-minute load average
next to its numbers, and `results/runs.jsonl` keeps all of it. A run taken at
load 4 is not comparable with one taken at load 0.3, and the file says which
is which.

The app is also not controlled, deliberately. A framework boot cannot be
separated from the application's own import graph — on the app measured here
about 4.6s of the boot is its `server.ts` eagerly importing 112 modules.
That belongs in the numbers, because the developer waits for it.
