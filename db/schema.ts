import { sql } from 'drizzle-orm';
import { sqliteTable, integer, text, check, index } from 'drizzle-orm/sqlite-core';
export const serviceState = sqliteTable('service_state', {
  id: integer('id').primaryKey(),
  revision: integer('revision').notNull().default(0),
  data: text('data').notNull(),
}, table => [check('single_service', sql`${table.id} = 1`), check('valid_data', sql`json_valid(${table.data})`)]);

export const visitors = sqliteTable('visitors', {
  id: text('id').primaryKey(),
  authKey: text('auth_key').notNull().unique(),
  createdAt: integer('created_at').notNull(),
});
export const reservationQueue = sqliteTable('reservation_queue', {
  sequence: integer('sequence').primaryKey({ autoIncrement: true }),
  requestKey: text('request_key').notNull().unique(),
  visitorId: text('visitor_id').notNull(),
  requestId: text('request_id').notNull(),
  payload: text('payload').notNull(),
  receivedAt: integer('received_at').notNull(),
}, table => [index('idx_reservation_queue_visitor_sequence').on(table.visitorId, table.sequence)]);
