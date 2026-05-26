/**
 * Shared Postgres counter — used by every backend bench so they all pay the
 * same authoritative-write cost (PG fsync etc.). The point of this is to
 * equalise the floor across sync / TanStack DB / Zero / Convex — without it,
 * sync's in-process Map writes look unrealistically cheap.
 */
import postgres from 'postgres';

export const sql = postgres(
	'postgresql://postgres:postgres@localhost:54330/zbench',
	{
		max: 5
	}
);

/** Atomic increment on the shared counter; returns the new value. */
export const bumpCounter = async (): Promise<number> => {
	const rows = await sql<{ n: string }[]>`
		update counters set n = n + 1 where id = 'c' returning n
	`;
	return Number(rows[0]?.n ?? 0);
};

/** Read the current counter value (for reads that need it). */
export const readCounter = async (): Promise<number> => {
	const rows = await sql<{ n: string }[]>`
		select n from counters where id = 'c'
	`;
	return Number(rows[0]?.n ?? 0);
};
