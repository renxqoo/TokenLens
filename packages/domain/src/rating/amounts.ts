/**
 * 结算金额双口径（纯函数）：
 *   calculated   用户侧实扣 = 真实 usage × 价格快照 × 系数（Decimal 全精度）
 *   upstreamCost 渠道侧成本 = 同一公式、系数恒 1（官方价口径），渠道进货额度按此扣减
 * 两个口径共用 calcAmount 的全部防御（负值/NaN/Infinity → 0、cached ≤ input、负价钳 0）。
 */
import type { Decimal } from '../wallet/money.js';
import { calcAmount, type AmountInput } from './pricing.js';
import type { UsageReceipt } from './types.js';

export interface SettleAmounts {
  calculated: Decimal;
  calculatedAmount: string;
  upstreamCost: string;
}

export function computeAmounts(data: UsageReceipt): SettleAmounts {
  const base: Omit<AmountInput, 'coefficient'> = {
    inputTokens: data.usage.inputTokens,
    cachedInputTokens: data.usage.cachedInputTokens,
    outputTokens: data.usage.outputTokens,
    cacheWriteTokens: data.usage.cacheWriteTokens ?? 0,
    inputPrice: data.inputPrice,
    cacheInputPrice: data.cacheInputPrice,
    cacheWritePrice: data.cacheWritePrice ?? '0',
    outputPrice: data.outputPrice,
    units: data.usage.units ?? 0,
    unitPrice: data.unitPrice ?? '0',
  };
  const calculated = calcAmount({ ...base, coefficient: data.coefficient });
  const upstream = calcAmount({ ...base, coefficient: '1' });
  return {
    calculated,
    calculatedAmount: calculated.toString(),
    upstreamCost: upstream.toString(),
  };
}
