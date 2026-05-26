import { defineSchema, defineTable } from 'convex/server';
import { v } from 'convex/values';

export default defineSchema({
	counters: defineTable({ key: v.string(), n: v.number() }).index('by_key', [
		'key'
	])
});
