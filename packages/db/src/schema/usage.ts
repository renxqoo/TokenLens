import {
  pgTable,
  bigserial,
  uuid,
  varchar,
  smallint,
  timestamp,
  bigint,
  boolean,
  numeric,
  index,
  uniqueIndex,
  check,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { users } from './users.js';
import { apps } from './apps.js';
import { apiKeys } from './api-keys.js';
import { channels } from './channels.js';
import { userSubscriptions } from './plans.js';

/**
 * usage_logs — 用量明细（只追加、长期保留，data-model.md §3.10）
 * 计费：amount = (未缓存输入×输入价 + 缓存输入×缓存价 + 输出×输出价)/1e6 × 系数
 * status: 0 成功已计费 / 1 失败不计费。预付费实扣不超过 authorized reservation。
 */
export const usageLogs = pgTable(
  'usage_logs',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    /** 网关内部请求 ID，天然幂等（同请求只计一次） */
    requestId: uuid('request_id').notNull(),
    userId: bigint('user_id', { mode: 'number' })
      .notNull()
      .references(() => users.id),
    appId: bigint('app_id', { mode: 'number' }).references(() => apps.id, {
      onDelete: 'set null',
    }),
    apiKeyId: bigint('api_key_id', { mode: 'number' }).references(() => apiKeys.id, {
      onDelete: 'set null',
    }),
    /** key / jwt */
    credentialType: varchar('credential_type', { length: 8 }).notNull(),
    externalModel: varchar('external_model', { length: 64 }).notNull(),
    realModel: varchar('real_model', { length: 128 }).notNull(),
    channelId: bigint('channel_id', { mode: 'number' }).references(() => channels.id, {
      onDelete: 'set null',
    }),
    inputTokens: bigint('input_tokens', { mode: 'number' }).notNull().default(0),
    /** 缓存命中输入（usage 无缓存字段时为 0） */
    cachedInputTokens: bigint('cached_input_tokens', { mode: 'number' }).notNull().default(0),
    /** 缓存写入 token（Anthropic cache_creation 5m+1h 合计；计量与审计列） */
    cacheWriteTokens: bigint('cache_write_tokens', { mode: 'number' }).notNull().default(0),
    /** 缓存写单价快照（元/百万 token） */
    cacheWritePrice: numeric('cache_write_price', { precision: 38, scale: 18 }).notNull().default('0'),
    outputTokens: bigint('output_tokens', { mode: 'number' }).notNull().default(0),
    /**
     * 单位计费计量（2026-08 扩展）：按次=次数 / 按张=张数 / 按秒=音频秒数 / 按字符=字符数。
     * token 计费模型恒为 0；单位计费模型 token 三项不参与结算（计价公式单一真相 money/amount.ts）。
     */
    units: bigint('units', { mode: 'number' }).notNull().default(0),
    /** 官方价快照（元/百万 token，numeric 全精度） */
    inputPrice: numeric('input_price', { precision: 38, scale: 18 }).notNull().default('0'),
    outputPrice: numeric('output_price', { precision: 38, scale: 18 }).notNull().default('0'),
    cacheInputPrice: numeric('cache_input_price', { precision: 38, scale: 18 })
      .notNull()
      .default('0'),
    /** 单位单价快照（元/单位；token 计费模型为 0） */
    unitPrice: numeric('unit_price', { precision: 38, scale: 18 }).notNull().default('0'),
    /** 费率卡系数快照（最终单价 = 官方价 × 系数） */
    coefficient: numeric('coefficient', { precision: 6, scale: 3 }).notNull(),
    /** 实扣费用（元，numeric 全精度）；预付费模式不超过 reserved amount。 */
    amount: numeric('amount', { precision: 38, scale: 18 }).notNull().default('0'),
    /** 按实际 usage 计算的理论费用；预付费模式下可能高于本次实扣。 */
    calculatedAmount: numeric('calculated_amount', { precision: 38, scale: 18 })
      .notNull()
      .default('0'),
    /** 上游成本估算（元，官方价×实际用量快照；供应商对账数据基础） */
    upstreamCost: numeric('upstream_cost', { precision: 38, scale: 18 }).notNull().default('0'),
    /**
     * 请求时点生效汇率快照（1 USD = ? CNY）：账单级追溯——这笔账的价格快照
     * 从哪个汇率环境产生一查便知；NULL = 历史行（fx 机制上线前）无此口径。
     */
    fxRate: numeric('fx_rate', { precision: 38, scale: 18 }),
    /** 指向 fx_rates 追加表的具体行（来源/时间/操作人的真相） */
    fxRateId: bigint('fx_rate_id', { mode: 'number' }),
    /** 套餐额度承担部分（默认 0） */
    planAmount: numeric('plan_amount', { precision: 38, scale: 18 }).notNull().default('0'),
    /** 余额承担部分（默认 0） */
    paygAmount: numeric('payg_amount', { precision: 38, scale: 18 }).notNull().default('0'),
    /** plan / payg（Key 类型分流后 'both' 结构性删除） */
    billedBy: varchar('billed_by', { length: 8 }).notNull(),
    subscriptionId: bigint('subscription_id', { mode: 'number' }).references(
      () => userSubscriptions.id,
    ),
    durationMs: bigint('duration_ms', { mode: 'number' }).notNull().default(0),
    status: smallint('status').notNull().default(1),
    stream: boolean('stream').notNull().default(false),
    /** 流式提前中断；只有供应商仍返回可信 usage 时才允许精确结算。 */
    streamAborted: boolean('stream_aborted').notNull().default(false),
    /**
     * 估算结算标记（2026-08-17 政策扩展）：用户取消 ∪ 完成缺 usage 且无可信
     * usage 时按估算结算的行。区分真实获取与估算，报表/对账分桶的口径来源
     * （receipt.estimatedFor 为权威归属）。
     */
    estimated: boolean('estimated').notNull().default(false),
    /**
     * 估算归属（ESTIMATE_ATTRIBUTIONS）：用户端展示与审计的一等公民字段
     * （「这笔是估算扣的、为什么」——取消三态 + 完成缺 usage 两态）。
     */
    estimateReason: varchar('estimate_reason', { length: 64 }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('usage_logs_request_id_uq').on(t.requestId),
    index('usage_logs_user_created_idx').on(t.userId, t.createdAt.desc()),
    index('usage_logs_model_created_idx').on(t.externalModel, t.createdAt),
    index('usage_logs_channel_created_idx').on(t.channelId, t.createdAt),
    index('usage_logs_subscription_idx').on(t.subscriptionId, t.createdAt),
    // Key 类型分流后 'both'（同一请求套餐+余额混扣）结构性不可达：DB 层强制只允许 plan/payg。
    check('usage_logs_billed_by_ck', sql`${t.billedBy} in ('plan','payg')`),
    // 金额不变量下沉（FINDINGS-2 静态项）：四方金额非负；成功单 amount = plan + payg。
    check(
      'usage_logs_amounts_nonnegative_ck',
      sql`${t.amount} >= 0 and ${t.planAmount} >= 0 and ${t.paygAmount} >= 0 and ${t.upstreamCost} >= 0`,
    ),
    check(
      'usage_logs_amount_split_ck',
      sql`(${t.status} <> 0) or (${t.amount} = ${t.planAmount} + ${t.paygAmount})`,
    ),
  ],
);
