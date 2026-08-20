import { describe, expect, it } from 'vitest';
import { Decimal } from '../../wallet/money.js';
import { computeAmounts } from '../amounts.js';
import { candidate, receiptFor } from './fixtures.js';

describe('computeAmounts（结算双口径）', () => {
  it('calculated ×系数；upstreamCost 系数恒 1（渠道成本官方价口径）', () => {
    const c = candidate({ inputPrice: '2', outputPrice: '6', cacheInputPrice: '1', coefficient: '1.5' });
    const r = receiptFor(c, 7, { usage: { inputTokens: 1_000_000, cachedInputTokens: 400_000, outputTokens: 200_000, estimated: false } });
    const amounts = computeAmounts(r);
    expect(amounts.calculatedAmount).toBe('4.2');
    expect(amounts.upstreamCost).toBe('2.8');
  });

  it('负成本钳 0（渠道成本不为负）', () => {
    const c = candidate({ inputPrice: '0', outputPrice: '0', cacheInputPrice: '0', coefficient: '1' });
    const amounts = computeAmounts(receiptFor(c, 7));
    expect(amounts.upstreamCost).toBe('0');
    expect(amounts.calculatedAmount).toBe('0');
  });
}
);

describe('computeAmounts 含 cache_write（双口径）', () => {
  it('calculated 乘系数、upstreamCost 恒 1——write 分量同口径', () => {
    const { computed } = { computed: computeAmounts({
      requestId: 'r', userId: 1, apiKeyId: null, appId: null, credentialType: 'key',
      externalModel: 'm', realModel: 'm', channelId: 1, channelKey: 'c',
      usage: { inputTokens: 1000, cachedInputTokens: 200, cacheWriteTokens: 100, outputTokens: 50, estimated: false },
      inputPrice: '1', outputPrice: '2', cacheInputPrice: '0.5', cacheWritePrice: '1.25',
      unitPrice: '0', coefficient: '1.2', durationMs: 1, stream: false, streamAborted: false,
      mappingId: 1, billingPolicyFingerprint: null,
    }) };
    // 700×1 + 200×0.5 + 100×1.25 + 50×2 = 1025 → /1M × 1.2
    expect(computed.calculated.toNumber()).toBeCloseTo((1025 / 1_000_000) * 1.2, 10);
    expect(new Decimal(computed.upstreamCost).toNumber()).toBeCloseTo(1025 / 1_000_000, 10);
  });
});
