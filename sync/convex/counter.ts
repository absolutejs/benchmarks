// NOTE: `./_generated/server` is created by `npx convex dev`/`deploy`. TypeScript
// errors here until you run that once — that's expected (it codegens the API).
import { mutation, query } from './_generated/server';

export const bump = mutation({
	args: {},
	handler: async (ctx) => {
		const existing = await ctx.db
			.query('counters')
			.withIndex('by_key', (q) => q.eq('key', 'c'))
			.unique();
		if (existing) {
			await ctx.db.patch(existing._id, { n: existing.n + 1 });

			return existing.n + 1;
		}
		await ctx.db.insert('counters', { key: 'c', n: 1 });

		return 1;
	}
});

export const get = query({
	args: {},
	handler: async (ctx) => {
		const row = await ctx.db
			.query('counters')
			.withIndex('by_key', (q) => q.eq('key', 'c'))
			.unique();

		return row?.n ?? 0;
	}
});
