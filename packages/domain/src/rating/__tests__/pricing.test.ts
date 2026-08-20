/** 计价公式攻击面：负数/NaN/超界输入钳 0、cached 夹逼、系数钳 0、上界保守。 */
import { describe, expect, it } from 'vitest';
import { Decimal } from '../../wallet/money.js';
import { calcAmount, estimateMaxCost, requiredReservation, ReservationError } from '../pricing.js';

describe('calcAmount（实扣口径）', () => {
  it('基础：uncached×输入价 + cached×缓存价 + 输出×输出价，除以 1M 乘系数', () => {
    const amount = calcAmount({
      inputTokens: 1_000_000,
      cachedInputTokens: 400_000,
      outputTokens: 200_000,
      inputPrice: '2',
      cacheInputPrice: '1',
      outputPrice: '6',
      coefficient: '1.5',
    });
    // (600k×2 + 400k×1 + 200k×6)/1M = 2.8 → ×1.5 = 4.2
    expect(amount.toString()).toBe('4.2');
  });

  it('单位计费（按次/张/秒）与 token 并存', () => {
    const amount = calcAmount({
      inputTokens: 0, cachedInputTokens: 0, outputTokens: 0,
      inputPrice: '0', cacheInputPrice: '0', outputPrice: '0',
      units: 3, unitPrice: '0.5', coefficient: '2',
    });
    expect(amount.toString()).toBe('3');
  });

  it('cached > input 时夹到 ≤ input（防负未缓存 + 超大缓存双计）', () => {
    const amount = calcAmount({
      inputTokens: 100,
      cachedInputTokens: 500, // 异常上游
      outputTokens: 0,
      inputPrice: '2', cacheInputPrice: '1', outputPrice: '0',
      coefficient: '1',
    });
    expect(amount.toNumber()).toBe(100 / 1_000_000); // cached 夹到 100，全按缓存价计
  });

  it('负 token / NaN / Infinity 输入全部钳 0', () => {
    const amount = calcAmount({
      inputTokens: -1000, cachedInputTokens: NaN, outputTokens: Infinity,
      inputPrice: '2', cacheInputPrice: '1', outputPrice: '6',
      coefficient: '1',
    });
    expect(amount.isZero()).toBe(true);
  });

  it('系数 ≤ 0 钳 0（配置错误不得免费/反向——授权侧另结构拒绝）', () => {
    const amount = calcAmount({
      inputTokens: 1_000_000, cachedInputTokens: 0, outputTokens: 0,
      inputPrice: '2', cacheInputPrice: '2', outputPrice: '0',
      coefficient: '-1.5',
    });
    expect(amount.isZero()).toBe(true);
  });

  it('负单价不产生负金额（钳 0 兜底）', () => {
    const amount = calcAmount({
      inputTokens: 1_000_000, cachedInputTokens: 0, outputTokens: 0,
      inputPrice: '-5', cacheInputPrice: '-5', outputPrice: '0',
      coefficient: '1',
    });
    expect(amount.isZero()).toBe(true);
  });

  it('全精度不 round（厘级尾差都不丢）', () => {
    const amount = calcAmount({
      inputTokens: 1, cachedInputTokens: 0, outputTokens: 1,
      inputPrice: '0.002', cacheInputPrice: '0.001', outputPrice: '0.003',
      coefficient: '1.1',
    });
    expect(amount.toString()).toBe('0.0000000055');
  });
});

describe('estimateMaxCost（预扣口径）', () => {
  it('输入按两种输入单价中较贵者（缓存命中量未知）', () => {
    const estimate = estimateMaxCost({
      estimatedInputTokens: 1_000_000,
      maxOutputTokens: 0,
      inputPrice: '2',
      cacheInputPrice: '1', // 便宜——不该被用来省押金
      outputPrice: '0',
      coefficient: '1',
    });
    expect(estimate.toString()).toBe('2');
  });

  it('输出按 max_tokens 上界全额预估', () => {
    const estimate = estimateMaxCost({
      estimatedInputTokens: 0,
      maxOutputTokens: 500_000,
      inputPrice: '2', cacheInputPrice: '2', outputPrice: '6',
      coefficient: '1',
    });
    expect(estimate.toString()).toBe('3');
  });

  it('非法系数返回 0（由 calculateRequired 后续结构拒绝）', () => {
    expect(
      estimateMaxCost({ estimatedInputTokens: 100, maxOutputTokens: 0, inputPrice: '2', outputPrice: '0', coefficient: '0' }).isZero(),
    ).toBe(true);
  });
});

describe('requiredReservation（单请求上限闸）', () => {
  it('限额内原样返回（绝不截断）', () => {
    expect(requiredReservation('2.5', '10').toString()).toBe('2.5');
    expect(requiredReservation('10', '10').toString()).toBe('10');
  });

  it('超限拒绝（reservation_limit_exceeded）', () => {
    expect(() => requiredReservation('10.01', '10')).toThrow(ReservationError);
  });

  it('非法估计/非法限额拒绝', () => {
    expect(() => requiredReservation('-1', '10')).toThrow(ReservationError);
    expect(() => requiredReservation('1', '0')).toThrow(ReservationError);
  });

  it('金额精度不受 Decimal 默认 20 位影响（precision 40）', () => {
    const tiny = new Decimal('0.000000000000000000123456');
    expect(requiredReservation(tiny, '1').toString()).toBe('0.000000000000000000123456');
  });
});

describe('cache_write 计价（0063 系数体系）', () => {
  const base = {
    inputTokens: 1000,
    cachedInputTokens: 300,
    outputTokens: 200,
    inputPrice: '1',
    cacheInputPrice: '0.1',
    outputPrice: '2',
    coefficient: '1',
  };

  it('三分段互斥：uncached + cached + write = input；write 分量按 cacheWritePrice 计价', () => {
    // 无写：1000 输入 = 700×1 + 300×0.1 + 200×2
    const noWrite = calcAmount(base);
    // 有写 200：500×1 + 300×0.1 + 200×1.25 + 200×2
    const withWrite = calcAmount({ ...base, cacheWriteTokens: 200, cacheWritePrice: '1.25' });
    const diff = withWrite.minus(noWrite);
    expect(diff.toNumber()).toBeCloseTo(((500 - 700) * 1 + 200 * 1.25) / 1_000_000, 10);
  });

  it('cached + write 超 input 时夹取（防负未缓存与双计）', () => {
    const out = calcAmount({ ...base, cacheWriteTokens: 999_999, cacheWritePrice: '10' });
    expect(out.gte(0)).toBe(true);
    // 夹后 write = 1000 − 300 = 700；uncached = 0
    const expected = (300 * 0.1 + 700 * 10 + 200 * 2) / 1_000_000;
    expect(out.toNumber()).toBeCloseTo(expected, 8);
  });

  it('系数作用于全部分量（用户价 = 官方分量和 × 系数）', () => {
    const coeff2 = calcAmount({ ...base, cacheWriteTokens: 200, cacheWritePrice: '1.25', coefficient: '1.5' });
    const coeff1 = calcAmount({ ...base, cacheWriteTokens: 200, cacheWritePrice: '1.25', coefficient: '1' });
    expect(coeff2.toNumber()).toBeCloseTo(coeff1.toNumber() * 1.5, 8);
  });

  it('cacheWritePrice 缺省/0 → 写 token 按输入价计（未配置不得逃逸计费）', () => {
    const zero = calcAmount({ ...base, cacheWriteTokens: 200 });
    const none = calcAmount(base);
    expect(zero.eq(none)).toBe(true);
  });

  it('estimateMaxCost：cacheWrite 超输入价时进贵价（Anthropic 1.25×/2×）', () => {
    const plain = estimateMaxCost({ estimatedInputTokens: 1000, maxOutputTokens: 0, inputPrice: '1', outputPrice: '0', coefficient: '1' });
    const withWrite = estimateMaxCost({ estimatedInputTokens: 1000, maxOutputTokens: 0, inputPrice: '1', cacheWritePrice: '2', outputPrice: '0', coefficient: '1' });
    expect(withWrite.toNumber()).toBeCloseTo(plain.toNumber() * 2, 8);
  });
});
