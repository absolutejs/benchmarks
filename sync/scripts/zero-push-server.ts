/**
 * Zero v1.5 push server — runs custom mutators authoritatively against
 * Postgres. zero-cache (configured with ZERO_PUSH_URL) forwards every client
 * mutation here. Each mutation runs in a Postgres transaction via
 * ZQLDatabase + PostgresJSConnection; this is what closes the loop for a
 * measured Zero benchmark. Run separately from the bench client:
 *   bun run scripts/zero-push-server.ts
 */
import { Elysia } from 'elysia';
import postgres from 'postgres';
import {
	PostgresJSConnection,
	PushProcessor,
	ZQLDatabase
} from '@rocicorp/zero/pg';
import { schema } from '../zero/schema';
import { createMutators } from '../zero/mutators';

const PORT = 5051;

const pg = postgres('postgresql://postgres:postgres@localhost:54330/zbench', {
	max: 10
});
const database = new ZQLDatabase(new PostgresJSConnection(pg), schema);
const processor = new PushProcessor(database);

new Elysia()
	.post('/push', ({ request }) => processor.process(createMutators(), request))
	.listen(PORT, () =>
		console.log(`zero-push listening at http://localhost:${PORT}/push`)
	);
