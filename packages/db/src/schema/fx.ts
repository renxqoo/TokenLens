import {
  bigint,
  bigserial,
  index,
  jsonb,
  numeric,
  pgTable,
  timestamp,
  varchar,
} from 'drizzle-orm/pg-core';

/**
 * fx_rates — 汇率追加表（只增不改，对账真相）：USD→CNY。
 * 自动拉取（source='ecb'，mode='auto'）与手动覆盖（source='manual'，mode='override'）
 * 各落一行；任何历史时点「当时用的什么汇率、从哪来、谁改的」查表即答。
 */
export const fxRates = pgTable(
  'fx_rates',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    baseCurrency: varchar('base_currency', { length: 8 }).notNull().default('USD'),
    quoteCurrency: varchar('quote_currency', { length: 8 }).notNull().default('CNY'),
    /** 1 USD = rate CNY（>0 由迁移 check 约束保证） */
    rate: numeric('rate', { precision: 38, scale: 18 }).notNull(),
    /** 汇率来源：ecb（frankfurter 自动）/ manual（运营覆盖） */
    source: varchar('source', { length: 16 }).notNull(),
    /** auto / override */
    mode: varchar('mode', { length: 8 }).notNull().default('auto'),
    /** 手动覆盖时的操作管理员（自动拉取为 null） */
    operatorAdminId: bigint('operator_admin_id', { mode: 'number' }),
    fetchedAt: timestamp('fetched_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('fx_rates_fetched_at_idx').on(t.fetchedAt)],
);

/**
 * system_configs — 运营配置 KV（jsonb 值）：当前承载目录汇率运行态
 * { mode, bufferPct, overrideRate, currentRate, currentFxRateId, source, fetchedAt }。
 * 缓存语义：真相恒在 fx_rates 与审计；本表只回答「现在生效什么」。
 */
export const systemConfigs = pgTable('system_configs', {
  key: varchar('key', { length: 64 }).primaryKey(),
  value: jsonb('value').notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  updatedByAdminId: bigint('updated_by_admin_id', { mode: 'number' }),
});
