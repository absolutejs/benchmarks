/**
 * Shared seed + helpers for the reactive-read bench suite. A `tasks` table
 * rich enough for ranged + ORDER BY queries, multi-row writes, and large
 * cold-hydration snapshots. Same Postgres container as the existing benches
 * (`docker exec sync-bench-pg ...`), separate from the `counter` table.
 */
import postgres from 'postgres';

export const sql = postgres(
	'postgresql://postgres:postgres@localhost:54330/zbench',
	{ max: 10 }
);

export type Task = {
	id: string;
	title: string;
	assignee: string;
	priority: number;
	done: boolean;
	createdAt: number;
};

const ASSIGNEES = ['alex', 'sam', 'jamie', 'pat', 'kim'] as const;

export const ensureSchema = async () => {
	await sql`
		create table if not exists rtasks (
			id text primary key,
			title text not null,
			assignee text not null,
			priority int not null,
			done boolean not null default false,
			created_at bigint not null
		)
	`;
	await sql`create index if not exists rtasks_assignee on rtasks(assignee)`;
	await sql`create index if not exists rtasks_priority on rtasks(priority)`;
};

/** Seed exactly `count` rows. Idempotent: clears the table first. */
export const seedTasks = async (count: number): Promise<void> => {
	await ensureSchema();
	await sql`truncate rtasks`;
	if (count === 0) return;
	const batch = 1000;
	for (let start = 0; start < count; start += batch) {
		const rows: Task[] = [];
		const end = Math.min(start + batch, count);
		for (let index = start; index < end; index += 1) {
			rows.push({
				assignee: ASSIGNEES[index % ASSIGNEES.length] ?? 'alex',
				createdAt: index,
				done: false,
				id: `t-${index}`,
				priority: (index * 7919) % 100,
				title: `Task ${index}`
			});
		}
		await sql`
			insert into rtasks ${sql(
				rows.map((task) => ({
					assignee: task.assignee,
					created_at: task.createdAt,
					done: task.done,
					id: task.id,
					priority: task.priority,
					title: task.title
				}))
			)}
		`;
	}
};

export const readAllTasks = async (): Promise<Task[]> => {
	const rows = await sql<
		Array<{
			id: string;
			title: string;
			assignee: string;
			priority: number;
			done: boolean;
			created_at: string;
		}>
	>`select id, title, assignee, priority, done, created_at from rtasks`;

	return rows.map((row) => ({
		assignee: row.assignee,
		createdAt: Number(row.created_at),
		done: row.done,
		id: row.id,
		priority: row.priority,
		title: row.title
	}));
};

export const readTasksByAssignee = async (
	assignee: string,
	orderByPriority = true
): Promise<Task[]> => {
	const rows = orderByPriority
		? await sql<
				Array<{
					id: string;
					title: string;
					assignee: string;
					priority: number;
					done: boolean;
					created_at: string;
				}>
			>`select id, title, assignee, priority, done, created_at from rtasks where assignee = ${assignee} order by priority asc`
		: await sql<
				Array<{
					id: string;
					title: string;
					assignee: string;
					priority: number;
					done: boolean;
					created_at: string;
				}>
			>`select id, title, assignee, priority, done, created_at from rtasks where assignee = ${assignee}`;

	return rows.map((row) => ({
		assignee: row.assignee,
		createdAt: Number(row.created_at),
		done: row.done,
		id: row.id,
		priority: row.priority,
		title: row.title
	}));
};

export const bumpTask = async (id: string): Promise<Task | null> => {
	const rows = await sql<
		Array<{
			id: string;
			title: string;
			assignee: string;
			priority: number;
			done: boolean;
			created_at: string;
		}>
	>`update rtasks set priority = priority + 1 where id = ${id}
	  returning id, title, assignee, priority, done, created_at`;
	const row = rows[0];
	if (!row) return null;

	return {
		assignee: row.assignee,
		createdAt: Number(row.created_at),
		done: row.done,
		id: row.id,
		priority: row.priority,
		title: row.title
	};
};

export const insertTask = async (task: Task): Promise<Task> => {
	// RETURNING + upsert with all columns mirrored from EXCLUDED so the
	// persisted row reflects the input exactly (and the function returns
	// what the DB actually wrote, not just the input).
	const rows = await sql<
		Array<{
			id: string;
			title: string;
			assignee: string;
			priority: number;
			done: boolean;
			created_at: string;
		}>
	>`
		insert into rtasks (id, title, assignee, priority, done, created_at)
		values (${task.id}, ${task.title}, ${task.assignee}, ${task.priority}, ${task.done}, ${task.createdAt})
		on conflict (id) do update set
			title = excluded.title,
			assignee = excluded.assignee,
			priority = excluded.priority,
			done = excluded.done,
			created_at = excluded.created_at
		returning id, title, assignee, priority, done, created_at
	`;
	const row = rows[0];
	if (!row) throw new Error(`insertTask returned no row for id=${task.id}`);

	return {
		assignee: row.assignee,
		createdAt: Number(row.created_at),
		done: row.done,
		id: row.id,
		priority: row.priority,
		title: row.title
	};
};

/** Insert N rows in a single transaction — for multi-row-tx throughput bench. */
export const insertManyInTx = async (rows: Task[]): Promise<void> => {
	if (rows.length === 0) return;
	await sql.begin(async (tx) => {
		await tx`
			insert into rtasks ${tx(
				rows.map((task) => ({
					assignee: task.assignee,
					created_at: task.createdAt,
					done: task.done,
					id: task.id,
					priority: task.priority,
					title: task.title
				}))
			)}
		`;
	});
};
