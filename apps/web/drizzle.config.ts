import { defineConfig } from 'drizzle-kit';

export default defineConfig({
	schema: '../../packages/schema/src/db.ts',
	out: './drizzle',
	dialect: 'postgresql',
	dbCredentials: {
		// Drizzle Kit's pg client doesn't pool, so we use the unpooled URL when
		// available — pgbouncer (the pooled URL) breaks DDL like CREATE TABLE.
		url: process.env.DATABASE_URL_UNPOOLED ?? process.env.DATABASE_URL ?? '',
	},
	verbose: true,
	strict: false,
});
