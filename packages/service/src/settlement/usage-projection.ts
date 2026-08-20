/**
 * usage_logs 投影装配（结算事务内的列映射）：
 * usage_logs 不是资金流水——资金事实在 wallet_legs；此表承载计量/计价快照与归属维度
 * （billedBy / planAmount / paygAmount），供报表与限额口径（每日上限按 amount 统计）。
 * 返回中性行形状，由 UsageLogRepository.insertUsageLog 落库（requestId 唯一约束幂等）。
 */
import { Decimal, type UsageReceipt } from '@ai-gateway/domain';

export interface UsageProjectionInput {
  receipt: UsageReceipt;
  billing: {
    userId: number;
    subscriptionId: number | null;
    channelId: number | null;
  };
  calculatedAmount: string;
  upstreamCost: string;
  /** 订阅来源消耗（含吸收超额）；0 = 纯 PAYG */
  planConsume: string;
}

export function usageLogProjection(input: UsageProjectionInput): Record<string, unknown> {
  const { receipt } = input;
  const planAmount = input.planConsume;
  return {
    requestId: receipt.requestId,
    userId: input.billing.userId,
    appId: receipt.appId,
    apiKeyId: receipt.apiKeyId,
    credentialType: receipt.credentialType,
    externalModel: receipt.externalModel,
    realModel: receipt.realModel,
    channelId: input.billing.channelId,
    inputTokens: receipt.usage.inputTokens,
    cachedInputTokens: receipt.usage.cachedInputTokens,
    cacheWriteTokens: receipt.usage.cacheWriteTokens ?? 0,
    outputTokens: receipt.usage.outputTokens,
    units: receipt.usage.units ?? 0,
    inputPrice: receipt.inputPrice,
    outputPrice: receipt.outputPrice,
    cacheInputPrice: receipt.cacheInputPrice,
    cacheWritePrice: receipt.cacheWritePrice ?? '0',
    unitPrice: receipt.unitPrice ?? '0',
    coefficient: new Decimal(receipt.coefficient).toFixed(3),
    amount: input.calculatedAmount,
    calculatedAmount: input.calculatedAmount,
    upstreamCost: input.upstreamCost,
    planAmount,
    paygAmount: new Decimal(input.calculatedAmount).minus(planAmount).toString(),
    // billedBy 跟随 planAmount（订阅实际吸收额）：绑定订阅但全走 PAYG 的混合单
    // 记 payg——否则出现 billedBy='plan' && subscriptionId=null 的矛盾行，
    // 日限/成员限额按 subscription_id 过滤会漏算
    billedBy: new Decimal(planAmount).gt(0) ? 'plan' : 'payg',
    subscriptionId:
      input.billing.subscriptionId != null && new Decimal(planAmount).gt(0)
        ? input.billing.subscriptionId
        : null,
    fxRate: receipt.fxRate ?? null,
    fxRateId: receipt.fxRateId ?? null,
    durationMs: receipt.durationMs,
    status: 0,
    stream: receipt.stream,
    streamAborted: receipt.streamAborted,
    estimated: receipt.usage.estimated,
    estimateReason: receipt.usage.estimated ? (receipt.estimatedFor ?? null) : null,
  };
}
