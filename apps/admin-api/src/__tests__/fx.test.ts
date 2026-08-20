/**
 * 目录汇率服务语义：冷启动懒拉、TTL 跳过、手动覆盖冻结、点差生效、
 * 校验拒绝、路由面（GET 状态 / PUT 覆盖 / PUT 点差 / DELETE 覆盖）。
 * fetch 全 mock（不打真 ECB；buildTestApp 的 fx 也已换 mock）。
 */
import { describe, expect, it } from 'vitest';
import { desc, eq } from 'drizzle-orm';
import { fxRates, systemConfigs } from '@ai-gateway/db';
import { createFxService } from '../services/fx.service.js';
import { CATALOG_FX_CONFIG_KEY } from '@ai-gateway/repository';
import { buildTestApp, db, newAdmin, uid } from './helpers.js';

const CTX = { requestId: `fx-${uid('t')}`, actor: { kind: 'admin' as const, id: 0 }, traceParent: null };
/** 审计 FK 需要真管理员行；服务直调测试统一用它拿 adminId */
async function realAdminId(): Promise<number> {
  return (await newAdmin()).id;
}

function ecbFetch(rate: number, calls: { n: number } = { n: 0 }): typeof fetch {
  return async () => {
    calls.n += 1;
    return new Response(JSON.stringify({ rates: { CNY: rate } }), { status: 200 });
  };
}

async function cleanup(): Promise<void> {
  await db.delete(systemConfigs).where(eq(systemConfigs.key, CATALOG_FX_CONFIG_KEY));
  await db.delete(fxRates).where(eq(fxRates.source, 'ecb'));
  await db.delete(fxRates).where(eq(fxRates.source, 'manual'));
}

describe('fx 服务（真 PG + mock ECB）', () => {
  it('冷启动懒拉落 auto 行 + 缓存视图；TTL 内不重复拉', async () => {
    await cleanup();
    const calls = { n: 0 };
    const fx = createFxService({ db, fetchImpl: ecbFetch(7.21, calls) });

    const s1 = await fx.state(CTX);
    expect(s1.baseRate).toBe('7.21');
    expect(s1.source).toBe('ecb');
    expect(s1.mode).toBe('auto');
    expect(s1.effectiveRate).toBe('7.21'); // buffer 0
    expect(calls.n).toBe(1);

    const rows = await db.select().from(fxRates).where(eq(fxRates.mode, 'auto')).orderBy(desc(fxRates.id));
    expect(rows[0]!.rate).toBe('7.210000000000000000');
    expect(s1.fxRateId).toBe(rows[0]!.id);

    // TTL 内第二次 state 不再拉；非强制 refresh 同样早退
    await fx.state(CTX);
    await fx.refresh(CTX, { adminId: await realAdminId(), force: false });
    expect(calls.n).toBe(1);

    // force 刷新绕过 TTL
    await fx.refresh(CTX, { adminId: await realAdminId(), force: true });
    expect(calls.n).toBe(2);
    await cleanup();
  });

  it('点差：effective = base ×(1+buffer/100)；覆盖态不叠点差', async () => {
    await cleanup();
    const fx = createFxService({ db, fetchImpl: ecbFetch(7.2) });
    await fx.state(CTX);

    const buffered = await fx.setBuffer(CTX, { adminId: await realAdminId(), bufferPct: '2' });
    expect(Number(buffered.effectiveRate)).toBeCloseTo(7.344, 8);
    expect(buffered.baseRate).toBe('7.2'); // 基准不动——点差只进预填

    const overridden = await fx.setOverride(CTX, { adminId: await realAdminId(), rate: '7.5' });
    expect(overridden.baseRate).toBe('7.5');
    expect(overridden.effectiveRate).toBe('7.5'); // 手动值自带判断，不叠点差
    expect(overridden.source).toBe('manual');

    const manualRow = await db.select().from(fxRates).where(eq(fxRates.mode, 'override')).orderBy(desc(fxRates.id));
    expect(manualRow[0]!.operatorAdminId).toBeGreaterThan(0);

    const cleared = await fx.clearOverride(CTX, { adminId: await realAdminId() });
    expect(cleared.mode).toBe('auto');
    expect(cleared.source).toBe('ecb');
    await cleanup();
  });

  it('校验：汇率/点差越界 400；拉取失败降级 null（不抛）', async () => {
    await cleanup();
    const fx = createFxService({ db, fetchImpl: ecbFetch(7.2) });
    const adminId = await realAdminId();
    await expect(fx.setOverride(CTX, { adminId, rate: '0' })).rejects.toMatchObject({ status: 400 });
    await expect(fx.setOverride(CTX, { adminId, rate: '9999' })).rejects.toMatchObject({ status: 400 });
    await expect(fx.setBuffer(CTX, { adminId, bufferPct: '60' })).rejects.toMatchObject({ status: 400 });

    const broken = createFxService({
      db,
      fetchImpl: async () => new Response('boom', { status: 500 }),
    });
    const s = await broken.state(CTX);
    expect(s.baseRate).toBeNull();
    expect(s.effectiveRate).toBeNull();
    await cleanup();
  });
});

describe('fx 路由（会话 + mock fetch）', () => {
  it('GET 状态 / PUT 覆盖 / PUT 点差 / DELETE 覆盖全覆盖', async () => {
    const { request } = buildTestApp();
    const { token } = await newAdmin();
    await cleanup();

    const state = await request('/v1/fx/catalog', { token });
    expect(state.status).toBe(200);
    const body = (await state.json()) as { baseRate: string | null; mode: string };
    expect(body.baseRate).toBe('7.2');

    const overridden = await request('/v1/fx/catalog/override', {
      token,
      method: 'PUT',
      body: { rate: '7.4' },
    });
    expect(overridden.status).toBe(200);
    expect(((await overridden.json()) as { baseRate: string }).baseRate).toBe('7.4');

    const buffered = await request('/v1/fx/catalog/buffer', {
      token,
      method: 'PUT',
      body: { bufferPct: '1.5' },
    });
    expect(buffered.status).toBe(200);
    expect(((await buffered.json()) as { bufferPct: string }).bufferPct).toBe('1.5');

    const cleared = await request('/v1/fx/catalog/override', { token, method: 'DELETE' });
    expect(cleared.status).toBe(200);
    expect(((await cleared.json()) as { mode: string }).mode).toBe('auto');
    await cleanup();
  });
});
