import { sql } from 'drizzle-orm';
import { sqliteTable, integer, text, check } from 'drizzle-orm/sqlite-core';
export const serviceState = sqliteTable('service_state', {
  id: integer('id').primaryKey(),
  revision: integer('revision').notNull().default(0),
  data: text('data').notNull(),
}, table => [check('single_service', sql`${table.id} = 1`), check('valid_data', sql`json_valid(${table.data})`)]);
