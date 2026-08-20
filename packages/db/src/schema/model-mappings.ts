import {
  check,
  pgTable,
  bigserial,
  varchar,
  smallint,
  timestamp,
  bigint,
  jsonb,
  index,
  uniqueIndex,
  numeric,
  boolean,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { channels } from './channels.js';

/**
 * model_mappings — 模型映射（对外模型名 → 真实模型，data-model.md §3.6）
 * 定价：input/output/cache_input 均为**官方价**（元/百万 token），用户价 = 官方价 × 费率卡系数
 */
export const modelMappings = pgTable(
  'model_mappings',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    externalName: varchar('external_name', { length: 64 }).notNull(),
  /** 上下文窗口（token 数）；null=未知。目录导入带入，可编辑。 */
  contextLength: bigint('context_length', { mode: 'number' }),
    realModel: varchar('real_model', { length: 128 }).notNull(),
    /** 0 上架 / 1 下架 */
    status: smallint('status').notNull().default(0),
    /** 官方输入单价（元/百万 token，numeric 全精度） */
    inputPrice: numeric('input_price', { precision: 38, scale: 18 }).notNull().default('0'),
    /** 官方输出单价 */
    outputPrice: numeric('output_price', { precision: 38, scale: 18 }).notNull().default('0'),
    /** 官方缓存输入单价（缓存命中计价；不启用缓存计费则与输入价同值） */
    cacheInputPrice: numeric('cache_input_price', { precision: 38, scale: 18 })
      .notNull()
      .default('0'),
    /**
     * 官方缓存写单价（元/百万 token；Anthropic 5m 档 1.25×/1h 档 2× 输入价）。
     * 0 = 该模型不收缓存写费（维持免计）。系数体系同 input/output：用户价 = 本价 × 费率卡系数。
     */
    cacheWritePrice: numeric('cache_write_price', { precision: 38, scale: 18 })
      .notNull()
      .default('0'),
    /**
     * 计费单位（单一真相，2026-08 单位计费扩展）：
     * token 按 token（三元组计价）/ request 按次 / image 按张 / second 按音频秒 / char 按字符。
     * 非 token 单位使用 unit_price 计价，token 三元组对该模型不参与结算。
     */
    pricingUnit: varchar('pricing_unit', { length: 16 }).notNull().default('token'),
    /** 单位单价（元/单位：次/张/秒/字符；token 单位模型恒为 0） */
    unitPrice: numeric('unit_price', { precision: 38, scale: 18 }).notNull().default('0'),
    /**
     * 定价分组键（可空）：费率卡 scope='group' 系数行按此键匹配（如 'anthropic'、'image-gen'）。
     * 系数解析优先级 model > group > global（packages/ledger coefficient.ts 单一真相）。
     */
    pricingGroup: varchar('pricing_group', { length: 32 }),
    /**
     * 显式免费模型标记：true 时授权走 0 元 fast-path（不预留余额/额度）。
     * 免费判定不再靠 `:free` 命名约定——由管理员在建模时显式声明，是唯一事实源。
     */
    isFree: boolean('is_free').notNull().default(false),
    /**
     * 可扩展计费配置（策略选择 + 变体价格表）：
     *   {"strategy": "flat"}                                    — 缺省，unitPrice 列直接生效
     *   {"strategy": "variant", "params": {"selector": "size", "prices": {"512x512": "0.02", "1024x1024": "0.04"}}}
     *   将来：tiered（阶梯）/ hybrid（底价+按量）
     * 与 pricingUnit 正交：pricingUnit = 计量维度（token/image/second/...）；本列 = 单价怎么选。
     */
    billingConfig: jsonb('billing_config').$type<{
      strategy?: string;
      params?: {
        unitPrice?: string;
        selector?: string;
        prices?: Record<string, string>;
      };
      /** 预扣策略（domain reservation-strategy 通用形状——不在此复刻字段） */
      reservation?: { strategy?: string; params?: Record<string, unknown> };
    }>().notNull().default({}),
    /** fallback 模型链（对外模型名数组，配置启用；默认空 = 不降级） */
    fallbackModels: jsonb('fallback_models').$type<string[]>(),
    /**
     * 参数抹平规则（透传基底，规则驱动，见 ai-package.md §7.6）：
     * {"ignore":[],"clamp":{},"map":{},"unknown":"passthrough"}
     */
    paramRules: jsonb('param_rules').$type<{
      ignore?: string[];
      clamp?: Record<string, { min?: number; max?: number }>;
      map?: Record<string, { to: string }>;
      unknown?: 'passthrough' | 'drop';
    }>(),
    /** 版本化多模态足额授权策略；最终结算仍只使用供应商可信 usage。 */
    billingPolicy: jsonb('billing_policy').$type<Record<string, unknown>>(),
    rpmLimit: bigint('rpm_limit', { mode: 'number' }),
    tpmLimit: bigint('tpm_limit', { mode: 'number' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('model_mappings_external_name_uq').on(t.externalName),
    index('model_mappings_pricing_group_idx').on(t.pricingGroup),
    // 价格非负（入口 zod 已拦，DB 兜底——负价经 calcAmount 钳 0 会静默免费）
    check(
      'model_mappings_prices_nonnegative_ck',
      sql`${t.inputPrice} >= 0 and ${t.outputPrice} >= 0 and ${t.cacheInputPrice} >= 0 and ${t.cacheWritePrice} >= 0 and ${t.unitPrice} >= 0`,
    ),
    // 计费单位词表（新增单位须同步 PRICING_UNITS 常量与计价公式）
    check(
      'model_mappings_pricing_unit_ck',
      sql`${t.pricingUnit} in ('token','request','image','second','char')`,
    ),
  ],
);

/**
 * model_channels — 映射 × 渠道 关联（data-model.md §3.7）
 * 上架约束：上架模型必须 ≥1 个可用渠道（应用层校验）
 */
export const modelChannels = pgTable(
  'model_channels',
  {
    mappingId: bigint('mapping_id', { mode: 'number' })
      .notNull()
      .references(() => modelMappings.id),
    channelId: bigint('channel_id', { mode: 'number' })
      .notNull()
      .references(() => channels.id),
    weight: bigint('weight', { mode: 'number' }).notNull().default(1),
    priority: bigint('priority', { mode: 'number' }).notNull().default(0),
  },
  (t) => [
    { name: 'model_channels_pk', columns: [t.mappingId, t.channelId], primaryKey: true },
    index('model_channels_channel_id_idx').on(t.channelId),
  ],
);
