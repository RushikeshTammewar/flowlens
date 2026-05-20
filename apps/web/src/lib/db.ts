import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import * as schema from '@flowlens/schema/db';

declare global {
	// eslint-disable-next-line no-var
	var __flowlensPgPool: Pool | undefined;
}

const pool =
	globalThis.__flowlensPgPool ??
	new Pool({
		connectionString: process.env.DATABASE_URL,
		max: 10,
	});

if (!globalThis.__flowlensPgPool) {
	globalThis.__flowlensPgPool = pool;
}

export const db = drizzle(pool, { schema });
export { schema };
