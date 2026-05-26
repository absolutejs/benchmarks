import type { CustomMutatorDefs, Transaction } from '@rocicorp/zero';
import type { Schema } from './schema';

export const createMutators = () =>
	({
		counter: {
			bump: async (tx: Transaction<Schema>) => {
				// The unique mutationID is a strictly increasing per-client integer —
				// a clean monotonic value to write without first reading the row.
				await tx.mutate.counters.update({
					id: 'c',
					n: tx.mutationID
				});
			}
		}
	}) as const satisfies CustomMutatorDefs<Schema>;
