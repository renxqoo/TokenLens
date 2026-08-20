/**
 * 计价域契约：计量收据（UsageReceipt）与授权报价（BillingQuote）——
 * 计费链路「价格/用量」的单一真相。授权端生产、结算端消费、验收共用。
 * 价格/系数用元 + 小数字符串（无整数编码），金额全程 Decimal 永不 round。
 */
import type { ReservationPolicyConfig } from './reservation-strategy.js';

export interface UsageReceipt {
  /** 幂等键（= billing_requests.request_id = usage_logs.request_id 唯一约束） */
  requestId: string;
  userId: number;
  apiKeyId: number | null;
  appId: number | null;
  /** key / jwt */
  credentialType: string;
  /** 对外模型名（用户请求的） */
  externalModel: string;
  /** 实际模型名（上游真实模型，可能经 fallback 切换） */
  realModel: string;
  /** 最终成功的渠道 ID */
  channelId: number | null;
  /** 最终成功的渠道名 */
  channelKey: string;
  usage: {
    inputTokens: number;
    cachedInputTokens: number;
    outputTokens: number;
    estimated: boolean;
    /** 缓存写入 token（Anthropic cache_creation 5m+1h 合计归一；0/缺省 = 无） */
    cacheWriteTokens?: number;
    /** 单位计量（按次/张/秒/字符；token 模型为 0）——与 unitPrice 快照配对结算 */
    units?: number;
  };
  /** 价格快照（元/百万 token，来自实际成功模型映射列） */
  inputPrice: string;
  outputPrice: string;
  cacheInputPrice: string;
  /** 缓存写单价快照（0/缺省 = 不收缓存写费） */
  cacheWritePrice?: string;
  /** 单位单价快照（元/单位；token 模型为 '0'） */
  unitPrice?: string;
  /** 费率卡系数（小数，如 1.0） */
  coefficient: string;
  /** 请求耗时 ms */
  durationMs: number;
  stream: boolean;
  streamAborted: boolean;
  /** 模型映射 ID（= 实际成功模型） */
  mappingId: number;
  /** 多模态策略快照指纹；纯文本为 null */
  billingPolicyFingerprint: string | null;
  /**
   * 请求时点生效基准汇率（1 USD = ? CNY）与 fx_rates 行 id——账单级追溯：
   * 这笔账的价格快照从哪个汇率环境产生一查便知；缺省 = fx 机制上线前的历史口径。
   */
  fxRate?: string | null;
  fxRateId?: number | null;
  /**
   * 估算结算归属（政策拍板）：用户侧取消 ∪ 完成缺 usage。
   * usage.estimated=true 时必填且必须属于 ESTIMATE_ATTRIBUTIONS（验收结构性把关）。
   */
  estimatedFor?: EstimateAttribution;
  /** 触发估算的透传字节数（校准作业与审计数据源；TTFB 期取消为 0） */
  bytesRelayed?: number;
}

/** 用户侧取消原因（网关路由判定与收据验收共用子集） */
export const USER_SIDE_CANCELS = ['client_disconnect', 'request_cancelled', 'aborted'] as const;
export type UserSideCancel = (typeof USER_SIDE_CANCELS)[number];

/**
 * 允许估算结算的全部归属：用户取消三态 + 完成缺 usage 两态。
 * 上游故障中断（超时/5xx/截断）不在此列——那类走释放不扣。
 */
export const ESTIMATE_ATTRIBUTIONS = [
  ...USER_SIDE_CANCELS,
  'usage_missing_completed',
  'usage_missing_nonstream',
] as const;
export type EstimateAttribution = (typeof ESTIMATE_ATTRIBUTIONS)[number];

/**
 * 估算归属判定（验收与结算共用单一真相）：无归属/白名单外的估算收据一律拒绝，
 * 不允许借估算口径给其他场景开后门。
 */
export function isAttributedEstimate(receipt: UsageReceipt): boolean {
  return (
    receipt.usage.estimated &&
    receipt.estimatedFor !== undefined &&
    (ESTIMATE_ATTRIBUTIONS as readonly string[]).includes(receipt.estimatedFor)
  );
}

export interface BillingQuoteCandidate {
  mappingId: number;
  externalModel: string;
  realModel: string;
  inputPrice: string;
  outputPrice: string;
  cacheInputPrice: string;
  /** 缓存写单价（0/缺省 = 不收） */
  cacheWritePrice?: string;
  /** 单位单价（元/单位；token 模型为 '0'）——预扣与结算共用 */
  unitPrice?: string;
  coefficient: string;
  /** 本候选请求输入 token 的可证明上界（文本字节或模型多模态硬上限） */
  inputTokenUpperBound: number;
  /** 计量维度（token/request/image/second/char）——预扣上界与结算 units 的推导依据 */
  pricingUnit?: string;
  /** 单位计量上界（如 images 的 n / audio 的秒；token 模型为 0） */
  unitUpperBound?: number;
  /** 预扣策略声明（billing_config.reservation 原样快照——authorize 放行门消费） */
  reservation?: ReservationPolicyConfig;
  /** 多模态策略快照指纹；纯文本为 null */
  billingPolicyFingerprint: string | null;
  /**
   * 请求时点生效基准汇率（1 USD = ? CNY）与 fx_rates 行 id——账单级追溯：
   * 这笔账的价格快照从哪个汇率环境产生一查便知；缺省 = fx 机制上线前的历史口径。
   */
  fxRate?: string | null;
  fxRateId?: number | null;
}

/** 已按供应商参数规则归一化后的可信报价输入 */
export interface BillingQuote {
  /** 已包含 n 等倍数后的最大输出 token 总量 */
  maxOutputTokens: number;
  candidates: BillingQuoteCandidate[];
  /** 只有显式免费策略才能产生 0 元授权 */
  explicitlyFree?: boolean;
}
