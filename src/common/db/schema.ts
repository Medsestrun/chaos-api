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
  avgOpenPrice: real('avgOpenPrice').notNull(),
  gridClosePrice: real('gridClosePrice').notNull(),
  avgClosePrice: real('avgClosePrice'),
});

export const orders = sqliteTable('orders', {
  id: integer('id', { mode: 'number' }).primaryKey(),
  size: real('size').notNull(),
  side: text('side', { enum: ['BUY', 'SELL'] }).notNull(),
  positionId: integer('position_id', { mode: 'number' }).references(() => positions.id),
  status: text('status', {
    enum: ['OPENED', 'CANCELLED', 'FILLED', 'PARTIALLY_FILLED'],
  }).notNull(),
  type: text('type', { enum: ['REGULAR', 'INITIAL_POSITIONS_BUY_UP', 'FILL_EMPTY_POSITIONS', 'ORDER_SIZE_INCREASE'] })
    .notNull()
    .default('REGULAR'),
  averagePrice: real('averagePrice').notNull(),
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
  enabled: integer('enabled', { mode: 'boolean' }).notNull(),
  settings: text('settings', { mode: 'json' }).notNull(),
  deleted: integer('deleted', { mode: 'boolean' }).notNull().default(false),
  createdAt: text('created_at').notNull().default(sql`(current_timestamp)`),
  startedAt: text('started_at'),
  description: text('description'),
  margin: real('margin').notNull().default(0),
  balance: real('balance').notNull().default(0),
});

export const orderSizeLevels = sqliteTable('order_size_levels', {
  id: integer('id', { mode: 'number' }).primaryKey({ autoIncrement: true }),
  strategyId: text('strategy_id')
    .references(() => strategies.id)
    .notNull(),
  size: real('size').notNull().default(0),
  levelStart: integer('level_start', { mode: 'number' }).notNull(),
  levelEnd: integer('level_end', { mode: 'number' }).notNull(),
});
