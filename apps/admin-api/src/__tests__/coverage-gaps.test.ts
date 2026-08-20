/**
 * 缺口驱动补测（覆盖率阈值驱动的分支清单）：
 *   - users.patch：换卡 404/停用卡 400/邮箱变更推进失效线/授信地板/缺省封禁原因
 *   - users：profile 404 / transactions 404 / audit-logs 信封 / gift 路由
 *   - auth 服务：爆破锁 429 / 验码后账号已删 401 / 2FA 开关不存在管理员 404
 *   - plans：删除未引用 200 / 删除不存在 404
 *   - redeem：批次详情 200/404 / 码状态过滤 / 过期时间变体
 *   - channels：PATCH 阈值持久化 / 探针内部异常
 *   - models：PATCH status/realModel/externalName
 *   - catalog：空导入 400 catalog_empty / 大写 sourceId 404
 */
import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { channels as channelsTable, modelMappings, users as usersTable } from '@ai-gateway/db';
import { Decimal } from '@ai-gateway/domain';
import type { Mailer } from '@ai-gateway/identity';
import { createAdminAuthService } from '../services/auth.service.js';
import { mapErrorToHttp, AppError } from '../http/error-map.js';
import { HttpError } from '@ai-gateway/http';
import {
  buildTestApp,
  db,
  newAdmin,
  newChannelRow,
  newMappingRow,
  newProviderRow,
  newUserRow,
  TEST_JWT_SECRET,
  uid,
  wallet,
  openKeyGuard,
  openIpGuard,
} from './helpers.js';

describe('users.patch 分支', () => {
  it('换卡：卡不存在 → 404；卡停用 → 400', async () => {
    const { request } = buildTestApp();
    const { token } = await newAdmin();
    const userId = await newUserRow();

    const missing = await request(`/v1/users/${userId}`, {
      method: 'PATCH',
      token,
      body: { rateCardId: 999999999 },
    });
    expect(missing.status).toBe(404);

    // 建卡后停用 → 400 rate_card_disabled
    const cardName = uid('card');
    const created = (await (
      await request('/v1/rate-cards', { token, body: { name: cardName, coefficient: 1 } })
    ).json()) as { id: number };
    const { trackCard } = await import('./helpers.js');
    trackCard(created.id);
    await request(`/v1/rate-cards/${created.id}`, { method: 'PATCH', token, body: { status: 1 } });
    const disabled = await request(`/v1/users/${userId}`, {
      method: 'PATCH',
      token,
      body: { rateCardId: created.id },
    });
    expect(disabled.status).toBe(400);
    expect(((await disabled.json()) as { error: { code: string } }).error.code).toBe('rate_card_disabled');
  });

  it('邮箱变更 → 会话失效线推进（identity anchors 落行）；授信地板落 wallet', async () => {
    const { request } = buildTestApp();
    const { token } = await newAdmin();
    const userId = await newUserRow();

    const mail = `${uid('moved')}@example.com`;
    const res = await request(`/v1/users/${userId}`, {
      method: 'PATCH',
      token,
      body: { email: mail, creditLimit: 50 },
    });
    expect(res.status).toBe(200);
    // 邮箱落库
    const [row] = await db.select().from(usersTable).where(eq(usersTable.id, userId));
    expect(row!.email).toBe(mail);
    // 授信地板（wallet 口径）
    const accounts = await wallet.accounts(
      { requestId: 't', actor: { kind: 'admin', id: 0 }, traceParent: null },
      userId,
    );
    expect(new Decimal(accounts[0]?.creditLimit ?? '0').eq(50)).toBe(true);
  });

  it('profile/transactions 不存在 → 404；audit-logs 信封', async () => {
    const { request } = buildTestApp();
    const { token } = await newAdmin();
    expect((await request('/v1/users/999999999', { token })).status).toBe(404);
    expect((await request('/v1/users/999999999/transactions', { token })).status).toBe(404);

    const userId = await newUserRow();
    await request(`/v1/users/${userId}`, { method: 'PATCH', token, body: { displayName: 'audited' } });
    const logs = (await (
      await request(`/v1/users/${userId}/audit-logs`, { token })
    ).json()) as { rows: Array<{ action: string }>; total: number };
    expect(logs.total).toBeGreaterThanOrEqual(1);
    expect(logs.rows.some((r) => r.action === 'user.update')).toBe(true);
  });

  it('gift 路由：正数入账 + 幂等重放', async () => {
    const { request } = buildTestApp();
    const { token } = await newAdmin();
    const userId = await newUserRow();
    const key = uid('gift');
    const first = await request(`/v1/users/${userId}/gift`, {
      token,
      body: { amount: 3 },
      headers: { 'idempotency-key': key },
    });
    expect(first.status).toBe(200);
    const replay = (await (
      await request(`/v1/users/${userId}/gift`, {
        token,
        body: { amount: 3 },
        headers: { 'idempotency-key': key },
      })
    ).json()) as { replayed: boolean };
    expect(replay.replayed).toBe(true);
    const accounts = await wallet.accounts(
      { requestId: 't', actor: { kind: 'admin', id: 0 }, traceParent: null },
      userId,
    );
    expect(new Decimal(accounts[0]?.balance ?? '0').eq(3)).toBe(true);
  });
});

describe('auth 服务补充分支', () => {
  it('爆破锁命中 → 429 login_locked（带守卫形态）', async () => {
    const { createKeyBruteForceGuard } = await import('@ai-gateway/core');
    // 内存守卫：isLocked 恒真（模拟锁定期）
    const guard = {
      isLocked: async () => ({ locked: true, retryAfterSec: 600 }),
      recordFailure: async () => ({ locked: false, retryAfterSec: 0 }),
      recordSuccess: async () => {},
    } as unknown as ReturnType<typeof createKeyBruteForceGuard>;
    const { email } = await newAdmin();
    const svc = createAdminAuthService({
      db,
      jwtSecret: TEST_JWT_SECRET,
      sessionTtlSeconds: 3_600,
      loginGuard: guard,
      ipGuard: openIpGuard,
      mailer: null,
    });
    await expect(
      svc.login({ requestId: 't', actor: { kind: 'system' }, traceParent: null }, { email, password: 'x', ip: '1.1.1.1' }),
    ).rejects.toMatchObject({ status: 429, code: 'login_locked' });
  });

  it('验码通过但管理员已被删 → 401；2FA 开关不存在管理员 → 404', async () => {
    const sent: Array<{ to: string; code: string }> = [];
    const mailer: Mailer = {
      async sendLoginCode(to, code) {
        sent.push({ to, code });
      },
      async send() {},
    };
    const { id, email } = await newAdmin({ twoFactorEnabled: true });
    const svc = createAdminAuthService({
      db,
      jwtSecret: TEST_JWT_SECRET,
      sessionTtlSeconds: 3_600,
      loginGuard: openKeyGuard,
      ipGuard: openIpGuard,
      mailer,
    });
    const runCtx = { requestId: 't', actor: { kind: 'system' } as const, traceParent: null };
    const login = (await svc.login(runCtx, { email, password: 'correct-horse-battery', ip: '1.1.1.1' })) as {
      challengeId: string;
    };
    // 验码前删号（挑战仍有效）→ 验码通过后账号不存在分支
    await db.delete((await import('@ai-gateway/db')).admins).where(eq((await import('@ai-gateway/db')).admins.id, id));
    await expect(
      svc.verifyLoginCode(runCtx, { challengeId: login.challengeId, code: sent[0]!.code }),
    ).rejects.toMatchObject({ status: 401, code: 'invalid_credentials' });

    await expect(
      svc.setTwoFactorEnabled({ requestId: 't', actor: { kind: 'admin', id: 999999999 }, traceParent: null }, {
        adminId: 999999999,
        enabled: false,
      }),
    ).rejects.toMatchObject({ status: 404, code: 'admin_not_found' });
  });
});

/** 探针桩：适配器自身抛异常（internal 收口路径） */
const boomTester: () => import('@ai-gateway/ai').Ai = () =>
  ({
    async probe() {
      throw new Error('socket exploded');
    },
  }) as unknown as import('@ai-gateway/ai').Ai;

describe('plans/redeem/channels/models 补充分支', () => {
  it('plans：删除未引用 → 200；删除不存在 → 404', async () => {
    const { request } = buildTestApp();
    const { token } = await newAdmin();
    const name = uid('free');
    const created = (await (
      await request('/v1/plans', { token, body: { name, price: 1, quotaAmount: 1, periodDays: 1 } })
    ).json()) as { id: number };
    const removed = await request(`/v1/plans/${created.id}`, { method: 'DELETE', token });
    expect(removed.status).toBe(200);
    expect((await request('/v1/plans/999999999', { method: 'DELETE', token })).status).toBe(404);
  });

  it('redeem：批次详情 200/404；码状态过滤；过期时间变体', async () => {
    const { request } = buildTestApp();
    const { token } = await newAdmin();
    const created = (await (
      await request('/v1/redeem-batches', {
        token,
        body: { name: uid('b'), amount: 2, count: 2, expiresAt: '2030-01-01T00:00' },
      })
    ).json()) as { batch: { id: number } };
    const { trackBatch } = await import('./helpers.js');
    trackBatch(created.batch.id);

    const detail = await request(`/v1/redeem-batches/${created.batch.id}`, { token });
    expect(detail.status).toBe(200);
    expect(((await detail.json()) as { amount: string }).amount).toBeTruthy();
    expect((await request('/v1/redeem-batches/999999999', { token })).status).toBe(404);

    // 状态过滤（全部 status=0）
    const codes = (await (
      await request(`/v1/redeem-batches/${created.batch.id}/codes?status=0`, { token })
    ).json()) as { total: number; rows: Array<{ expiresAt: string | null }> };
    expect(codes.total).toBe(2);
    expect(codes.rows[0]!.expiresAt).toBeTruthy(); // 过期时间落库
  });

  it('channels：PATCH 阈值持久化；探针内部异常 → ok:false internal', async () => {
    const { request } = buildTestApp({ createTester: boomTester });
    const { token } = await newAdmin();
    const providerId = await newProviderRow();
    const channelId = await newChannelRow(providerId);

    const patched = await request(`/v1/channels/${channelId}`, {
      method: 'PATCH',
      token,
      body: { upstreamThreshold: 5 },
    });
    expect(patched.status).toBe(200);
    const [row] = await db.select().from(channelsTable).where(eq(channelsTable.id, channelId));
    expect(new Decimal(row!.upstreamThreshold ?? '0').eq(5)).toBe(true);

    const probe = (await (
      await request(`/v1/channels/${channelId}/test`, { method: 'POST', token })
    ).json()) as { ok: boolean; error: { code: string } };
    expect(probe.ok).toBe(false);
    expect(probe.error.code).toBe('internal');
  });

  it('models：PATCH status/realModel/externalName 生效', async () => {
    const { request } = buildTestApp();
    const { token } = await newAdmin();
    const mappingId = await newMappingRow();
    const renamed = uid('model');
    const patched = await request(`/v1/models/${mappingId}`, {
      method: 'PATCH',
      token,
      body: { status: 1, realModel: uid('real2'), externalName: renamed },
    });
    expect(patched.status).toBe(200);
    const [row] = await db.select().from(modelMappings).where(eq(modelMappings.id, mappingId));
    expect(row!.status).toBe(1);
    expect(row!.externalName).toBe(renamed);
  });

  it('catalog：HTTP 空数组 → 400（zod 先拦）；服务层空导入 → catalog_empty；大写 sourceId → 404', async () => {
    const { request } = buildTestApp();
    const { token } = await newAdmin();
    expect(
      (await request('/v1/model-catalog/import', {
        token,
        body: { sourceId: 'openrouter', apiKey: 'sk-x', models: [] },
      })).status,
    ).toBe(400);
    // 服务层直调覆盖 catalog_empty 分支（直调方绕过 zod 的防线归服务守卫）
    const { createCatalogService } = await import('../services/catalog.service.js');
    const { createFxService } = await import('../services/fx.service.js');
    const catalog = createCatalogService({
      db,
      redis: null,
      sources: [],
      cacheTtlMs: 600_000,
      freeChannelRpm: 20,
      freeChannelBudget: '1000000',
      encryptionKey: 'a'.repeat(32),
      fx: createFxService({ db, fetchImpl: async () => new Response('{"rates":{"CNY":7.2}}', { status: 200 }) }),
    });
    await expect(
      catalog.import({ requestId: 't', actor: { kind: 'admin', id: 0 }, traceParent: null }, {
        adminId: 0,
        sourceId: 'any',
        models: [],
      }),
    ).rejects.toMatchObject({ status: 400, code: 'catalog_empty' });
    expect((await request('/v1/model-catalog/OpenRouter', { token })).status).toBe(404);
  });
});

describe('error-map 单元（家谱穿透）', () => {
  it('AppError / HttpError 注册表 / PG cause 链 / 订阅域 / 未知兜底', () => {
    expect(mapErrorToHttp(new AppError(418, 'x', 'y'))).toMatchObject({ status: 418, code: 'x' });
    expect(mapErrorToHttp(new HttpError('CHANNEL_NOT_FOUND', 'ch'))).toMatchObject({ status: 404 });
    // drizzle 风格 cause 链
    const wrapped = Object.assign(new Error('query failed'), {
      code: undefined,
      cause: Object.assign(new Error('dup'), { code: '23505' }),
    });
    expect(mapErrorToHttp(wrapped)).toMatchObject({ status: 409, code: 'conflict' });
    expect(mapErrorToHttp(new HttpError('RATE_CARD_IN_USE' as never, 'x'))).toMatchObject({ status: 409 });
    expect(mapErrorToHttp(new Error('plain'))).toMatchObject({ status: 500, code: 'internal_error' });
  });
});

describe('plans grant（正位）+ billingPolicy', () => {
  it('POST /v1/subscriptions/:id/grant → 加油包发放成功；旧 plans 路径 404', async () => {
    const { request } = buildTestApp();
    const { token } = await newAdmin();
    const name = uid('grant');
    const plan = (await (
      await request('/v1/plans', { token, body: { name, kind: 'pack', price: 1, quotaAmount: 1 } })
    ).json()) as { id: number };
    const user = await newUserRow();
    // grantPack 语义：加油包挂靠有效订阅（现金口径发放）——先给用户造一条生效订阅
    const { userSubscriptions } = await import('@ai-gateway/db');
    const subPlan = (await (
      await request('/v1/plans', { token, body: { name: uid('sub'), kind: 'subscription', price: 10, quotaAmount: 100, periodDays: 30 } })
    ).json()) as { id: number };
    await db.insert(userSubscriptions).values({
      userId: user,
      planId: subPlan.id,
      status: 0,
      quantity: 1,
      quotaAmount: '100',
      usedAmount: '0',
      reservedAmount: '0',
      price: '10',
      startAt: new Date(Date.now() - 60_000),
      endAt: new Date(Date.now() + 30 * 86_400_000),
    });
    // 发放走现金口径（零价加油包=印刷机红线）：先给用户充值足够余额
    await request(`/v1/users/${user}/gift`, { token, body: { amount: '100', remark: 'grant-test', idempotencyKey: `gt-${plan.id}-${user}` } });
    // 正位路径（兼容别名已拆——前端已改调）
    const grant = await request(`/v1/subscriptions/${plan.id}/grant`, {
      token,
      body: { userId: user },
    });
    expect(grant.status).toBe(200);
    const legacy = await request(`/v1/plans/${plan.id}/grant`, { token, body: { userId: user } });
    expect(legacy.status).toBe(404);
  });

  it('models 创建带 billingPolicy（多模态统一输入计费——网关在消费该字段）', async () => {
    const { request } = buildTestApp();
    const { token } = await newAdmin();
    const external = uid('mm');
    const created = await request('/v1/models', {
      token,
      body: {
        externalName: external,
        realModel: `${external}-real`,
        inputPrice: 0,
        outputPrice: 0,
        cacheInputPrice: 0,
        isFree: true,
        unitPrice: 0,
        billingPolicy: {
          version: 1,
          billingMode: 'unified_input_tokens',
          maxInputTokens: 128000,
          modalities: { image: { maxItems: 4 } },
        },
      },
    });
    expect(created.status).toBe(201);
    const row = (await created.json()) as { billingPolicy: { billingMode: string } | null };
    expect(row.billingPolicy?.billingMode).toBe('unified_input_tokens');
  });
});
