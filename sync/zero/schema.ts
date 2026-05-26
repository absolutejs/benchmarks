import {
	createSchema,
	definePermissions,
	ANYONE_CAN_DO_ANYTHING,
	number,
	string,
	table
} from '@rocicorp/zero';

const counters = table('counters')
	.columns({
		id: string(),
		n: number()
	})
	.primaryKey('id');

export const schema = createSchema({ tables: [counters] });

export type Schema = typeof schema;

export const permissions = definePermissions<Record<string, unknown>, Schema>(
	schema,
	() => ({
		counters: ANYONE_CAN_DO_ANYTHING
	})
);
