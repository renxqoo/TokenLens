/**
 * 计价公式（token/单位 → 金额的纯函数；预扣与结算共用的单一真相）：
 *
 *   calcAmount        实扣口径：真实 usage × 价格快照 × 系数（用户实付）
 *   estimateMaxCost   预扣口径：上界 × 贵价 × 系数（事前押金，宁可多押不可少押）
 *   requiredReservation 单请求上限闸：超限只拒绝，绝不截断
 *
 * 资损防线：输入经 safe() 规范化（负/NaN/Infinity → 0）、cached 夹到 ≤ input、
 * coefficient ≤ 0 与负单价钳 0——任何异常上游响应或配置错误都算不出负金额
 * （反向收费/白嫖）。Decimal 全精度，账本永不 round。
 */
import { Decimal } from '../wallet/money.js';

export const PRICE_PER_MILLION = 1_000_000;

/** 数值规范化：非有限/负数 → 0（异常上游响应不产生错误金额） */
function safe(value: number): number {
  return Number.isFinite(value) && value > 0 ? value : 0;
}

export interface AmountInput {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  /**
   * 缓存写入 token（Anthropic cache_creation 5m+1h 合计归一）。
   * 口径：与 cached 同为输入的互斥分段——uncached = input − cached − cacheWrite。
   */
  cacheWriteTokens?: number;
  /** 输入价（元/百万 token） */
  inputPrice: Decimal | string | number;
  cacheInputPrice: Decimal | string | number;
  /** 缓存写单价（0/缺省 = 不收缓存写费） */
  cacheWritePrice?: Decimal | string | number;
  outputPrice: Decimal | string | number;
  /** 单位计量（次数/张数/秒数/字符数；token 模型传 0） */
  units?: number;
  /** 单位单价（元/单位；token 模型传 '0'） */
  unitPrice?: Decimal | string | number;
  /** 费率卡系数（用户侧口径；渠道成本恒 1） */
  coefficient: Decimal | string | number;
}

/**
 * 实扣金额（元）：
 *   uncached = inputTokens − cached（inputTokens 为总输入，含缓存命中）
 *   amount = (uncached×输入价 + cached×缓存价 + 输出×输出价)/1M + units×单位价) × 系数
 * cached 夹到 ≤ input（防异常上游返回 cached > total 导致负未缓存 + 超大缓存双计）。
 */
export function calcAmount(input: AmountInput): Decimal {
  const inputTokens = safe(input.inputTokens);
  const outputTokens = safe(input.outputTokens);
  const coefficient = new Decimal(input.coefficient as string);
  // coefficient ≤ 0 → 钳 0（配置错误不得免费/反向；授权侧另结构拒绝）
  const coeff = coefficient.lte(0) ? new Decimal(0) : coefficient;
  // 三段互斥（uncached / cacheRead / cacheWrite），合计夹到 ≤ input
  // （防异常上游返回 cached+write > total 导致负未缓存 + 超大缓存双计）
  const cached = Math.min(safe(input.cachedInputTokens), inputTokens);
  const cacheWrite = Math.min(safe(input.cacheWriteTokens ?? 0), inputTokens - cached);
  const uncached = inputTokens - cached - cacheWrite;
  // 写价 0/缺省 = 未配置 → 与输入价同值（cacheInputPrice 同款约定：
  // 未配置不得让写 token 逃逸计费——按普通输入计）
  const configuredWritePrice = new Decimal((input.cacheWritePrice ?? 0) as string);
  const effectiveWritePrice = configuredWritePrice.gt(0)
    ? configuredWritePrice
    : new Decimal(input.inputPrice as string);
  const tokenBase = new Decimal(input.inputPrice as string)
    .times(uncached)
    .plus(new Decimal(input.cacheInputPrice as string).times(cached))
    .plus(effectiveWritePrice.times(cacheWrite))
    .plus(new Decimal(input.outputPrice as string).times(outputTokens));
  const unitPrice = new Decimal((input.unitPrice ?? 0) as string);
  const unitBase = unitPrice.lt(0) ? new Decimal(0) : unitPrice.times(safe(input.units ?? 0));
  const amount = tokenBase.div(PRICE_PER_MILLION).plus(unitBase).times(coeff);
  return amount.lt(0) ? new Decimal(0) : amount;
}

export interface ReservationEstimateInput {
  estimatedInputTokens: number;
  maxOutputTokens: number;
  inputPrice: Decimal | string | number;
  /** 授权时无法预知缓存命中/写入量——输入按各单价中最高者覆盖（cacheWrite 可超输入价：Anthropic 1.25×/2×） */
  cacheInputPrice?: Decimal | string | number;
  cacheWritePrice?: Decimal | string | number;
  outputPrice: Decimal | string | number;
  /** 单位计量上界（如 images 的 n；token 模型 0） */
  unitUpperBound?: number;
  unitPrice?: Decimal | string | number;
  coefficient: Decimal | string | number;
}

/**
 * 预扣上界估算：输入按贵价、输出按上界、单位按上界——宁可多押不可少押。
 * 系数非法（≤0/非有限）返回 0（由 calculateRequired 的后续校验结构拒绝）。
 */
export function estimateMaxCost(input: ReservationEstimateInput): Decimal {
  const coefficient = new Decimal(input.coefficient as string);
  if (!coefficient.isFinite() || coefficient.lte(0)) return new Decimal(0);
  const conservativeInputPrice = Decimal.max(
    new Decimal(input.inputPrice as string),
    new Decimal((input.cacheInputPrice ?? input.inputPrice) as string),
    new Decimal((input.cacheWritePrice ?? input.inputPrice) as string),
  );
  const tokenBase = conservativeInputPrice
    .times(safe(input.estimatedInputTokens))
    .plus(new Decimal(input.outputPrice as string).times(safe(input.maxOutputTokens)));
  const unitPrice = new Decimal((input.unitPrice ?? 0) as string);
  const unitBase = unitPrice.lt(0) ? new Decimal(0) : unitPrice.times(safe(input.unitUpperBound ?? 0));
  const cost = tokenBase.div(PRICE_PER_MILLION).plus(unitBase).times(coefficient);
  return cost.isFinite() && cost.gte(0) ? cost : new Decimal(0);
}

export type ReservationErrorCode = 'invalid_reservation_estimate' | 'invalid_reservation_limit' | 'reservation_limit_exceeded';

export class ReservationError extends Error {
  constructor(public readonly code: ReservationErrorCode) {
    super(code);
    this.name = 'ReservationError';
  }
}

/**
 * 单请求上限闸：余额由账本事务足额判断；风险上限只用于拒绝，绝不截断
 * （截断 = 静默少押 = 把配置问题伪装成正常放行）。
 */
export function requiredReservation(
  estimate: Decimal | string | number,
  reservationLimit: Decimal | string | number,
): Decimal {
  const required = new Decimal(estimate as string);
  const limit = new Decimal(reservationLimit as string);
  if (!required.isFinite() || required.lt(0)) {
    throw new ReservationError('invalid_reservation_estimate');
  }
  if (!limit.isFinite() || limit.lte(0)) {
    throw new ReservationError('invalid_reservation_limit');
  }
  if (required.gt(limit)) {
    throw new ReservationError('reservation_limit_exceeded');
  }
  return required;
}
