/**
 * 收据装配（app 纯装配）：结算验收消费的 durable 快照——价格取自授权 quote 的
 * 命中候选（防中途改价），usage 取自上游可信回执；缺 usage 走估算归属政策
 * （usage_missing_nonstream ∈ 白名单，2026-08-17 政策）。
 *
 * 单位计量（units）：按命中候选声明的 pricingUnit 走计量注册表取结算实值——
 * 响应实值优先（images 张数），参数兜底（audio 秒 / speech 字符）；
 * token 模型 units 恒 0（金额全部走 token 三价）。units 是结算公式
 * unitPrice × units 的计数源——不装配即 0 元结算（漏收）。
 */
import { measurementOf } from '@ai-gateway/domain';
import type { BillingQuoteCandidate, UsageReceipt } from '@ai-gateway/domain';

export interface ReceiptParams {
  requestId: string;
  userId: number;
  apiKeyId: number | null;
  /** App-JWT 凭证（null = 静态 Key/playground）——usage_logs 归属与订阅结算维度 */
  appId?: number | null;
  candidate: BillingQuoteCandidate;
  externalModel: string;
  channelId: number | null;
  channelKey: string;
  durationMs: number;
  /** 原始请求体——计量描述符的参数源（audioSeconds / n / input） */
  body: Record<string, unknown>;
  /** 请求时点生效汇率快照（repos.fx.current；null = 未配置/拉取失败——追溯降级） */
  fx?: { rate: string; fxRateId: number } | null;
  /** 上游响应体——计量描述符的实值源（images 的 data.length）；估算分支可缺 */
  responseBody?: unknown;
  usage:
    | { estimated: false; inputTokens: number; cachedInputTokens: number; outputTokens: number; cacheWriteTokens?: number }
    | { estimated: true; inputTokens: number; outputTokens?: number };
}

export function buildReceipt(params: ReceiptParams): UsageReceipt {
  const { candidate } = params;
  const units = measurementOf(candidate.pricingUnit ?? 'token').unitsOf(params.body, params.responseBody);
  return {
    requestId: params.requestId,
    userId: params.userId,
    apiKeyId: params.apiKeyId,
    appId: params.appId ?? null,
    credentialType: params.appId != null ? 'jwt' : 'key',
    externalModel: params.externalModel,
    realModel: candidate.realModel,
    channelId: params.channelId,
    channelKey: params.channelKey,
    usage: params.usage.estimated
      ? {
          inputTokens: params.usage.inputTokens,
          cachedInputTokens: 0,
          outputTokens: params.usage.outputTokens ?? 0,
          estimated: true,
          ...(units > 0 ? { units } : {}),
        }
      : {
          inputTokens: params.usage.inputTokens,
          cachedInputTokens: params.usage.cachedInputTokens,
          outputTokens: params.usage.outputTokens,
          estimated: false,
          ...((params.usage.cacheWriteTokens ?? 0) > 0 ? { cacheWriteTokens: params.usage.cacheWriteTokens } : {}),
          ...(units > 0 ? { units } : {}),
        },
    inputPrice: candidate.inputPrice,
    outputPrice: candidate.outputPrice,
    cacheInputPrice: candidate.cacheInputPrice,
    cacheWritePrice: candidate.cacheWritePrice ?? '0',
    unitPrice: candidate.unitPrice ?? '0',
    coefficient: candidate.coefficient,
    durationMs: params.durationMs,
    stream: false,
    streamAborted: false,
    mappingId: candidate.mappingId,
    billingPolicyFingerprint: candidate.billingPolicyFingerprint,
    fxRate: params.fx?.rate ?? null,
    fxRateId: params.fx?.fxRateId ?? null,
    ...(params.usage.estimated ? { estimatedFor: 'usage_missing_nonstream' } : {}),
    ...(params.usage.estimated ? { bytesRelayed: 0 } : {}),
  };
}
