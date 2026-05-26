import type { CustomMutatorDefs, Transaction } from '@rocicorp/zero';
import type { Schema } from './schema';

export const createMutators = () =>
	({
		counter: {
			bump: async (tx: Transaction<Schema>) => {
				const current = await tx.query.counters
					.where('id', '=', 'c')
					.one();
				if (current !== undefined) {
					await tx.mutate.counters.update({
						id: 'c',
						n: Number(current.n) + 1
					});
				} else {
					await tx.mutate.counters.insert({ id: 'c', n: 1 });
				}
			}
		}
	}) as const satisfies CustomMutatorDefs<Schema>;
