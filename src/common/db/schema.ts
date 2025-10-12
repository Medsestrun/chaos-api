import { sql } from 'drizzle-orm';
import { integer, real, sqliteTable, text } from 'drizzle-orm/sqlite-core';

export const positions = sqliteTable('positions', {
  id: integer('id', { mode: 'number' }).primaryKey({ autoIncrement: true }),
  size: real('size').notNull(),
  strategyId: text('strategy_id')
    .references(() => strategies.id)
    .notNull(),
  status: text('status', { enum: ['OPENED', 'CLOSED'] }).notNull(),
  gridOpenPrice: real('gridOpenPrice').notNull(),
  gridClosePrice: real('gridClosePrice'),
});

export const orders = sqliteTable('orders', {
  id: integer('id', { mode: 'number' }).primaryKey(),
  size: real('size').notNull(),
  side: text('side', { enum: ['BUY', 'SELL'] }).notNull(),
  positionId: integer('position_id', { mode: 'number' }).references(() => positions.id),
  status: text('status', {
    enum: ['OPENED', 'CANCELLED', 'FILLED', 'PARTIALLY_FILLED'],
  }).notNull(),
  price: real('price').notNull(),
  fee: real('fee').notNull().default(0),
  closedPnl: real('closedPnl').notNull().default(0),
  createdAt: text('created_at').notNull().default(sql`(current_timestamp)`),
  closedAt: text('closed_at'),
});

export const fundings = sqliteTable('fundings', {
  time: integer('time', { mode: 'number' }).primaryKey(),
  size: real('size').notNull(),
  rate: real('rate').notNull(),
  fee: real('fee').notNull().default(0),
});

export const strategies = sqliteTable('strategies', {
  id: text('id').primaryKey(),
  credentialsId: integer('credentials_id', { mode: 'number' }).references(() => credentials.id),
  enabled: integer('enabled', { mode: 'boolean' }).notNull(),
  settings: text('settings', { mode: 'json' }).notNull(),
  deleted: integer('deleted', { mode: 'boolean' }).notNull().default(false),
  createdAt: text('created_at').notNull().default(sql`(current_timestamp)`),
  startedAt: text('started_at'),
  description: text('description'),
  margin: real('margin').notNull().default(0),
  balance: real('balance').notNull().default(0),
});

export const credentials = sqliteTable('credentials', {
  id: integer('id', { mode: 'number' }).primaryKey({ autoIncrement: true }),
  userId: text('user_id').notNull(),
  name: text('name').notNull(),
  exchange: text('exchange', { enum: ['HYPERLIQUID', 'BINANCE'] }).notNull(),
  data: text('data', { mode: 'json' }).notNull(),
});
