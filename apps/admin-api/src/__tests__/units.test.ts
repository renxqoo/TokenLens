/**
 * 分支缺口收尾（单元级 + 路由可选字段）：凭证存储边界 / 目录缓存与空目录 /
 * models 更新分支 / funds 直调 / auth 补充分支 / 2FA HTTP 全链 / idParam 非法。
 */
import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { modelMappings } from '@ai-gateway/db';
import { Decimal } from '@ai-gateway/domain';
import type { Ai } from '@ai-gateway/ai';
import { createAdminAuthService } from '../services/auth.service.js';
import { createCatalogService, type CatalogSource } from '../services/catalog.service.js';
import { mapOpenAiCompatibleCatalog } from '../domain/catalog.js';
import { createFxService } from '../services/fx.service.js';
import { createFundsService } from '../services/funds.service.js';
import { createLocalVoucherStorage, parseVoucherDataUrl } from '../services/voucher-storage.js';
import {
  buildTestApp,
  capturingMailer,
  db,
  fundUser,
  newAdmin,
  newMappingRow,
  newPlanRow,
  newProviderRow,
  newUserRow,
  TEST_JWT_SECRET,
  uid,
  wallet,
  openKeyGuard,
  openIpGuard,
} from './helpers.js';

const runCtx = { requestId: 'units', actor: { kind: 'system' } as const, traceParent: null };

describe('凭证存储边界', () => {
  it('save 白名单外 MIME → 400；load 未知扩展/不存在 → null', async () => {
    const storage = createLocalVoucherStorage('/tmp/aav2-voucher-unit');
    await expect(storage.save(Buffer.from('x'), 'text/html')).rejects.toMatchObject({
      status: 400,
      code: 'invalid_voucher',
    });
    expect(await storage.load('00000000-0000-4000-8000-000000000000.exe')).toBeNull();
    expect(await storage.load('00000000-0000-4000-8000-000000000000.png')).toBeNull();
  });

  it('parseVoucherDataUrl：非 data URL / 超限 → 400', () => {
    expect(() => parseVoucherDataUrl('https://evil.example/x.png', 100)).toThrowError();
    expect(() => parseVoucherDataUrl(`data:image/png;base64,${'A'.repeat(64)}`, 10)).toThrowError(/上限/);
  });
});

describe('目录源缓存与空目录', () => {
  it('TTL 内二次比对走缓存（fetch 只打一次）；空目录回空货架；源清单', async () => {
    const hits = { count: 0 };
    const source: CatalogSource = {
      id: 'cache-src',
      name: 'CacheSrc',
      kind: 'channel',
      priceCurrency: 'USD',
      channel: {
        providerName: uid('cs-prov'),
        providerBaseUrl: 'https://cache.example.com/v1',
        providerProtocol: 'openai-compatible',
        channelName: uid('cs-ch'),
        needsKey: false,
      },
      fetchModels: async () => {
        hits.count += 1;
        return { data: [] };
      },
      mapModels: (raw) => mapOpenAiCompatibleCatalog(raw, { currency: 'USD' }),
    };
    const catalog = createCatalogService({
      db,
      redis: null,
      sources: [source],
      cacheTtlMs: 600_000,
      freeChannelRpm: 20,
      freeChannelBudget: '1000000',
      encryptionKey: 'a'.repeat(32),
      fx: createFxService({ db, fetchImpl: async () => new Response('{"rates":{"CNY":7.2}}', { status: 200 }) }),
    });
    const first = await catalog.comparison(runCtx, source.id);
    await catalog.comparison(runCtx, source.id); // 二次比对命中缓存
    expect(hits.count).toBe(1);
    expect(first.items).toEqual([]);
    expect(first.channelReady).toBe(false);
    expect(catalog.listSources()).toHaveLength(1);
  });
});

/** 探针桩：空完成（无 error 字段——empty_response 收口路径） */
const emptyAi: () => Ai = () =>
  ({ async chat() { return { status: 'empty', durationMs: 1 }; } }) as unknown as Ai;

describe('models 更新可选字段分支', () => {
  it('PATCH 仅 status / 仅 rpm+tpm / 三价全改 / 仅 externalName', async () => {
    const { request } = buildTestApp();
    const { token } = await newAdmin();
    const mappingId = await newMappingRow();

    expect((await request(`/v1/models/${mappingId}`, { method: 'PATCH', token, body: { status: 1 } })).status).toBe(200);
    expect(
      (await request(`/v1/models/${mappingId}`, { method: 'PATCH', token, body: { rpmLimit: 60, tpmLimit: 6000 } })).status,
    ).toBe(200);
    const prices = await request(`/v1/models/${mappingId}`, {
      method: 'PATCH',
      token,
      body: { inputPrice: 1.5, outputPrice: 2.5, cacheInputPrice: 0.5 },
    });
    expect(prices.status).toBe(200);
    const [row] = await db.select().from(modelMappings).where(eq(modelMappings.id, mappingId));
    expect(row!.rpmLimit).toBe(60);
    expect(new Decimal(row!.inputPrice).eq(1.5)).toBe(true);

    const renamed = uid('m');
    expect(
      (await request(`/v1/models/${mappingId}`, { method: 'PATCH', token, body: { externalName: renamed } })).status,
    ).toBe(200);
  });

  it('探针空完成 → empty_response', async () => {
    const { request } = buildTestApp({ createTester: emptyAi });
    const { token } = await newAdmin();
    const providerId = await newProviderRow();
    const channelId = (
      (await (
        await request('/v1/channels', { token, body: { providerId, name: uid('ch'), apiKey: 'sk-empty' } })
      ).json()) as { id: number }
    ).id;
    const mappingId = await newMappingRow();
    await request(`/v1/models/${mappingId}/channels`, { token, body: { channels: [{ channelId }] } });
    const probe = (await (
      await request(`/v1/models/${mappingId}/test`, { method: 'POST', token })
    ).json()) as { results: Array<{ ok: boolean; error: { code: string } }> };
    expect(probe.results[0]!.ok).toBe(false);
    expect(probe.results[0]!.error.code).toBe('empty_response');
  });
});

describe('funds 服务直调（remark null 分支）', () => {
  it('remark null 的正/负调账与赠送（审计与业务同事务落库）', async () => {
    const funds = createFundsService({ db, wallet });
    const userId = await newUserRow();
    // 审计行 admin_id 有 FK——直调也要用真管理员（生产行为一致：审计可追溯到人）
    const { id: adminId } = await newAdmin();

    const plus = await funds.adjust(runCtx, { adminId, userId, amount: '7', remark: null, operationId: uid('adj') });
    expect(plus.replayed).toBe(false);
    const minus = await funds.adjust(runCtx, { adminId, userId, amount: '-2', remark: null, operationId: uid('adj') });
    expect(new Decimal(minus.balanceAfter).eq(5)).toBe(true);
    const gift = await funds.gift(runCtx, { adminId, userId, amount: '1', remark: null, operationId: uid('gift') });
    expect(new Decimal(gift.balanceAfter).eq(6)).toBe(true);

    // 调账/赠送各留一条同事务审计（资金操作的主观察面）
    const audits = await db.$client.query<{ action: string; admin_id: number }>(
      'select action, admin_id from audit_logs where target_type = $1 and target_id = $2 order by id', ['user', String(userId)],
    );
    expect(audits.rows.map((r) => r.action).toSorted()).toEqual(['admin.adjust', 'admin.adjust', 'admin.gift']);
    expect(audits.rows.every((r) => Number(r.admin_id) === adminId)).toBe(true);
  });
});

describe('auth 补充分支', () => {
  it('验码通过但账号封禁 → 403；2FA 关闭不要求 SMTP；IP 锁 429', async () => {
    const { mailer, sent } = capturingMailer();
    const { id, email } = await newAdmin({ twoFactorEnabled: true });
    const svc = createAdminAuthService({
      db, jwtSecret: TEST_JWT_SECRET, sessionTtlSeconds: 3_600, loginGuard: openKeyGuard, ipGuard: openIpGuard, mailer,
    });
    const login = (await svc.login(runCtx, { email, password: 'correct-horse-battery', ip: '1.1.1.1' })) as {
      challengeId: string;
    };
    const { admins } = await import('@ai-gateway/db');
    await db.update(admins).set({ status: 1 }).where(eq(admins.id, id));
    await expect(
      svc.verifyLoginCode(runCtx, { challengeId: login.challengeId, code: sent[0]!.code }),
    ).rejects.toMatchObject({ status: 403, code: 'account_unavailable' });

    const off = await svc.setTwoFactorEnabled(runCtx, { adminId: id, enabled: false });
    expect(off).toEqual({ twoFactorEnabled: false });

    const { createAuthFailureGuard } = await import('@ai-gateway/core');
    const ipGuard = {
      isLocked: async () => ({ locked: true, retryAfterSec: 300 }),
      recordFailure: async () => ({ locked: false, retryAfterSec: 0 }),
    } as unknown as ReturnType<typeof createAuthFailureGuard>;
    const locked = createAdminAuthService({
      db, jwtSecret: TEST_JWT_SECRET, sessionTtlSeconds: 3_600, loginGuard: openKeyGuard, ipGuard, mailer: null,
    });
    await expect(
      locked.login(runCtx, { email, password: 'x', ip: '9.9.9.9' }),
    ).rejects.toMatchObject({ status: 429, code: 'login_locked' });
  });

  it('2FA HTTP 全链：登录 → code_required（无 token）→ 验码发 token', async () => {
    const { mailer, sent } = capturingMailer();
    const { request } = buildTestApp({ mailer });
    const { email } = await newAdmin({ twoFactorEnabled: true });

    const first = await request('/v1/auth/login', { body: { email, password: 'correct-horse-battery' } });
    expect(first.status).toBe(200);
    const firstBody = (await first.json()) as { twoFactorRequired: boolean; challengeId: string; token?: string };
    expect(firstBody.twoFactorRequired).toBe(true);
    expect(firstBody.token).toBeUndefined();
    expect(sent).toHaveLength(1);

    const verified = await request('/v1/auth/login/verify', {
      body: { challengeId: firstBody.challengeId, code: sent[0]!.code },
    });
    expect(verified.status).toBe(200);
    const { token } = (await verified.json()) as { token: string };
    expect((await request('/v1/me', { token })).status).toBe(200);
  });
});

describe('路由可选字段与非法路径分支', () => {
  it('keys 无过滤列表 / providers 显式 status / rate-cards 带 description / 登录带 XFF', async () => {
    const { request } = buildTestApp();
    const { token } = await newAdmin();
    expect((await request('/v1/admin-keys', { token })).status).toBe(200);
    expect(
      (await request('/v1/providers', {
        token,
        body: { name: uid('st'), baseUrl: 'https://st.example.com/v1', status: 0 },
      })).status,
    ).toBe(201);
    expect(
      (await request('/v1/rate-cards', { token, body: { name: uid('desc'), coefficient: 1, description: '扫尾' } })).status,
    ).toBe(201);

    const { email } = await newAdmin();
    const xffLogin = await request('/v1/auth/login', {
      body: { email, password: 'correct-horse-battery' },
      headers: { 'x-forwarded-for': '203.0.113.9, 10.0.0.1' },
    });
    expect(xffLogin.status).toBe(200);
  });

  it('channels 显式 weight/priority；subscriptions change 缺省 quantity=1', async () => {
    const { request } = buildTestApp();
    const { token } = await newAdmin();
    const providerId = await newProviderRow();
    expect(
      (await request('/v1/channels', {
        token,
        body: { providerId, name: uid('ch'), apiKey: 'sk-w', weight: 5, priority: 2 },
      })).status,
    ).toBe(201);

    const userId = await newUserRow();
    const lowPlan = await newPlanRow({ price: '10', quotaAmount: '10' });
    const highPlan = await newPlanRow({ price: '20', quotaAmount: '20' });
    const { plans } = await import('@ai-gateway/db');
    await db.update(plans).set({ sortOrder: 1 }).where(eq(plans.id, lowPlan));
    await db.update(plans).set({ sortOrder: 2 }).where(eq(plans.id, highPlan));
    await fundUser(userId, '100');
    const { createSubscriptionDomain } = await import('@ai-gateway/service');
    const domain = createSubscriptionDomain({ db, wallet });
    const purchased = await domain.purchase(runCtx, { operationId: uid('buy'), userId, planId: lowPlan, quantity: 1 });
    const changed = await request(`/v1/subscriptions/${purchased.subscriptionId}/change`, {
      token,
      body: { targetPlanId: highPlan },
      headers: { 'idempotency-key': uid('chg') },
    });
    expect(changed.status).toBe(200);
    expect(((await changed.json()) as { quantity: number }).quantity).toBe(1);
  });

  it('keys/providers PATCH 非整数路径 → 400 invalid_param', async () => {
    const { request } = buildTestApp();
    const { token } = await newAdmin();
    expect((await request('/v1/admin-keys/abc', { method: 'PATCH', token, body: { status: 1 } })).status).toBe(400);
    expect((await request('/v1/providers/abc', { method: 'PATCH', token, body: { name: uid('x') } })).status).toBe(400);
  });

  it('channel-funds：无过滤列表（全量流水信封）', async () => {
    const { request } = buildTestApp();
    const { token } = await newAdmin();
    const res = await request('/v1/channel-funds', { token });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { rows: unknown[]; total: number; page: number };
    expect(body.page).toBe(1);
    expect(Array.isArray(body.rows)).toBe(true);
  });
});

describe('过滤组合与单字段 PATCH 收尾', () => {
  it('rate-cards PATCH 仅 name；subscriptions 三过滤组合；channel-funds type 过滤 + 带备注调账', async () => {
    const { request } = buildTestApp();
    const { token } = await newAdmin();
    const { trackCard } = await import('./helpers.js');

    const card = (await (
      await request('/v1/rate-cards', { token, body: { name: uid('c'), coefficient: 1 } })
    ).json()) as { id: number };
    trackCard(card.id);
    expect(
      (await request(`/v1/rate-cards/${card.id}`, { method: 'PATCH', token, body: { name: uid('c2') } })).status,
    ).toBe(200);

    const filtered = await request('/v1/subscriptions?status=0&userId=999999999&planId=1', { token });
    expect(filtered.status).toBe(200);

    const providerId = await newProviderRow();
    const { newChannelRow } = await import('./helpers.js');
    const channelId = await newChannelRow(providerId);
    await request('/v1/channel-funds/adjust', {
      token,
      body: { channelId, amount: 5, remark: '带备注调账' },
      headers: { 'idempotency-key': uid('adj') },
    });
    const typed = (await (
      await request(`/v1/channel-funds?channelId=${channelId}&type=adjust`, { token })
    ).json()) as { rows: Array<{ type: string }>; total: number };
    expect(typed.total).toBe(1);
    expect(typed.rows[0]!.type).toBe('adjust');
  });

  it('models：全零价模型 PATCH isFree=true 合法；contextLength 清空', async () => {
    const { request } = buildTestApp();
    const { token } = await newAdmin();
    const created = (await (
      await request('/v1/models', {
        token,
        body: { externalName: uid('free'), realModel: uid('r'), inputPrice: 0, outputPrice: 0, cacheInputPrice: 0, contextLength: 1000 },
      })
    ).json()) as { id: number };
    expect(
      (await request(`/v1/models/${created.id}`, { method: 'PATCH', token, body: { isFree: true } })).status,
    ).toBe(200);
    const cleared = await request(`/v1/models/${created.id}`, {
      method: 'PATCH',
      token,
      body: { contextLength: null },
    });
    expect(cleared.status).toBe(200);
  });
});

describe('idParam 非法分支全路由扫尾', () => {
  it('每个资源面的非整数路径 → 400 invalid_param', async () => {
    const { request } = buildTestApp();
    const { token } = await newAdmin();
    const cases: Array<[string, string]> = [
      ['DELETE', '/v1/models/abc'],
      ['DELETE', '/v1/rate-cards/abc'],
      ['POST', '/v1/subscriptions/abc/cancel'],
      ['GET', '/v1/users/abc'],
      ['POST', '/v1/users/abc/set-password'],
      ['GET', '/v1/users/abc/transactions'],
      ['GET', '/v1/users/abc/audit-logs'],
      ['GET', '/v1/redeem-batches/abc'],
      ['GET', '/v1/redeem-batches/abc/codes'],
      ['POST', '/v1/redeem-batches/codes/abc/revoke'],
      ['GET', '/v1/rate-cards/abc/users'],
      ['GET', '/v1/rate-cards/abc/health'],
      ['POST', '/v1/models/abc/channels'],
      ['POST', '/v1/models/abc/test'],
      ['POST', '/v1/channels/abc/test'],
    ];
    for (const [method, path] of cases) {
      const res = await request(path, { method, token, body: method === 'POST' ? {} : undefined });
      expect(res.status, `${method} ${path}`).toBe(400);
    }
  });
});

describe('通知渠道 secret 落库加密', () => {
  it('create 后 config.secret 为 enc: 密文（读取侧掩码不变）', async () => {
    const { token } = await newAdmin();
    const { request } = buildTestApp();
    const created = await request('/v1/notifications', {
      token,
      body: {
        name: uid('sec'),
        type: 'webhook',
        config: { url: 'https://hooks.example.test/x', secret: 'whsec-plain-123456' },
        events: ['billing_dead'],
      },
    });
    expect(created.status).toBe(201);
    const row = (await created.json()) as { id: number; config: { secret?: string } };
    // 读取侧：掩码（不回明文也不回密文全文）
    expect(row.config.secret).toMatch(/^\*\*\*\*/);
    // 落库侧：密文前缀（直接查库验证）
    try {
      const stored = await db.$client.query<{ config: { secret?: string } }>(
        'select config from notification_channels where id = $1', [row.id],
      );
      expect(stored.rows[0]!.config.secret!.startsWith('enc:')).toBe(true);
    } finally {
      // 断言失败也不残留渠道（残留渠道会匹配 worker 派发→连带他测试投递失败）
      await request(`/v1/notifications/${row.id}`, { method: 'DELETE', token }).catch(() => undefined);
    }
  });
});
