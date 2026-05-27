// Wire-bandwidth bench helpers — a query that returns the full table + a
// mutation that bumps one row's priority. Used by
// scripts/reactive/wire-bytes-convex.ts to measure how many bytes Convex
// pushes per single-row mutation when the subscriber holds K rows.
import { mutation, query } from './_generated/server';
import { v } from 'convex/values';

export const list = query({
	args: {},
	handler: async (ctx) => {
		return await ctx.db.query('rtasks').collect();
	}
});

// Convex caps single-function reads at 4096 and writes at 16000. A naive
// "delete all + insert N" mutation breaches the read cap once the table has
// >4096 rows. We split into:
//   - purgePage: delete up to PAGE rows; bench calls in a loop until 0.
//   - seedRange: insert rows [from, to). Bench calls in chunks under the cap.
const PAGE = 1000;

export const purgePage = mutation({
	args: {},
	handler: async (ctx) => {
		const page = await ctx.db.query('rtasks').take(PAGE);
		for (const row of page) await ctx.db.delete(row._id);

		return page.length;
	}
});

export const seedRange = mutation({
	args: { from: v.number(), to: v.number() },
	handler: async (ctx, args) => {
		for (let index = args.from; index < args.to; index += 1) {
			await ctx.db.insert('rtasks', {
				title: `Task ${index}`,
				priority: index
			});
		}

		return args.to - args.from;
	}
});

export const bumpFirst = mutation({
	args: {},
	handler: async (ctx) => {
		// Bump the first row's priority — one-row write, but Convex re-sends
		// the whole `list` result to every subscriber on every iteration.
		const rows = await ctx.db.query('rtasks').collect();
		const first = rows[0];
		if (!first) return null;
		await ctx.db.patch(first._id, { priority: first.priority + 1 });

		return first.priority + 1;
	}
});
