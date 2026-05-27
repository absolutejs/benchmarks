import { defineSchema, defineTable } from 'convex/server';
import { v } from 'convex/values';

export default defineSchema({
	counters: defineTable({ key: v.string(), n: v.number() }).index('by_key', [
		'key'
	]),
	// For the wire-bandwidth bench: a table holding K rows where one mutation
	// per iteration bumps one row's priority. Convex pushes the whole new
	// query result on each change (their open issue #95); sync pushes a
	// per-row diff. The bandwidth gap should scale with K.
	rtasks: defineTable({
		title: v.string(),
		priority: v.number()
	})
});
