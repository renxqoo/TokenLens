/**
 * 推理管线集成测试（真实 PG + stub 上游端口）：资金编排全链——
 * 预扣 → 渠道预留 → 换渠（可换错误）→ 收据 signal → 三路归还（全败）。
 * 生产上游适配器（ai 包/SSE）是 G4b；此处验证的是钱的编排正确性。
 */
import { createHash, randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { createDb } from '@ai-gateway/db';
import { fxRates, users } from '@ai-gateway/db';
import type { Db } from '@ai-gateway/repository';
import { Decimal, type UsageReceipt } from '@ai-gateway/domain';
import { createBillingDomain, createSettlementDomain, createWallet, type BillingDomain } from '@ai-gateway/service';
import { systemContext, type RunContext } from '@ai-gateway/service';
import { createApp } from '../app.js';
import { createBuildQuote } from '../quote/build-quote.js';
import { createResolveChannels } from '../routing/resolve-channels.js';
import type { RateLimitGate } from '../rate-limit/gate.js';
import { createRunChat, signalSucceededWithRetry, SIGNAL_FINALIZE_ATTEMPTS, type ChatCompletionBody } from '../pipeline/run-chat.js';
import type { UpstreamPort, UpstreamResult, UpstreamStreamEvent } from '../pipeline/upstream-port.js';

const db: Db = createDb(
  process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/ai_gateway',
  { poolMax: 5 },
);
const ctx: RunContext = systemContext('v2gp-suite');
const billing = createBillingDomain({ db, currency: 'CNY' });
const buildQuote = createBuildQuote({ db });
const resolveChannels = createResolveChannels({ db, rng: () => 0 });
const wallet = createWallet({
  db,
  currency: 'CNY',
  guards: { refTypes: ['billing', 'topup'], currencies: ['CNY'], internalAccounts: ['platform_revenue', 'outside'] },
});

const createdUsers: number[] = [];
const createdKeys: number[] = [];
const createdMappings: number[] = [];
const createdChannels: number[] = [];
const createdProviders: number[] = [];
const createdRequests: string[] = [];

const tag = () => `v2gp-${randomUUID().slice(0, 8)}`;

async function seedModelWithChannels(
  channelSpecs: Array<{ budget?: string }>,
  options: {
    fallbackModels?: string[];
    realModel?: string;
    /** 定价覆盖：单位计费模型（pricingUnit + unitPrice + billingConfig；token 三价可清零） */
    pricing?: { pricingUnit?: string; unitPrice?: string; billingConfig?: Record<string, unknown>; inputPrice?: string; outputPrice?: string; cacheInputPrice?: string; cacheWritePrice?: string };
  } = {},
): Promise<{ model: string; channelNames: string[]; realModel: string }> {
  const { modelMappings, modelChannels, channels, providers } = await import('@ai-gateway/db');
  const [provider] = await db
    .insert(providers)
    .values({ name: tag(), baseUrl: 'https://v2gp.test', protocol: 'openai-compatible', status: 0 })
    .returning({ id: providers.id });
  createdProviders.push(provider!.id);
  const realModel = options.realModel ?? `real-${tag()}`;
  const externalName = tag();
  const [mapping] = await db
    .insert(modelMappings)
    .values({
      externalName,
      realModel,
      status: 0,
      inputPrice: options.pricing?.inputPrice ?? '2',
      outputPrice: options.pricing?.outputPrice ?? '6',
      cacheInputPrice: options.pricing?.cacheInputPrice ?? '1',
      ...(options.pricing?.cacheWritePrice !== undefined ? { cacheWritePrice: options.pricing.cacheWritePrice } : {}),
      ...(options.pricing?.pricingUnit !== undefined ? { pricingUnit: options.pricing.pricingUnit } : {}),
      ...(options.pricing?.unitPrice !== undefined ? { unitPrice: options.pricing.unitPrice } : {}),
      ...(options.pricing?.billingConfig !== undefined ? { billingConfig: options.pricing.billingConfig } : {}),
      ...(options.fallbackModels ? { fallbackModels: options.fallbackModels } : {}),
    })
    .returning({ id: modelMappings.id });
  createdMappings.push(mapping!.id);
  // priority 递减保证 rng=0 时按种子序调度
  const channelNames: string[] = [];
  for (let i = 0; i < channelSpecs.length; i++) {
    const name = `ch-${i}-${tag()}`;
    const [channel] = await db
      .insert(channels)
      .values({ providerId: provider!.id, name, apiKeyEnc: 'enc', status: 0, upstreamBudget: channelSpecs[i]!.budget ?? '1000' })
      .returning({ id: channels.id });
    createdChannels.push(channel!.id);
    await db.insert(modelChannels).values({ mappingId: mapping!.id, channelId: channel!.id, priority: 100 - i, weight: 1 });
    channelNames.push(name);
  }
  return { model: externalName, channelNames, realModel };
}

async function newFundedKey(amount = '100'): Promise<{ raw: string; userId: number; apiKeyId: number }> {
  const [user] = await db
    .insert(users)
    .values({ issuer: 'v2gp', subject: `v2gp-${randomUUID()}`, identityProvider: 'local' })
    .returning({ id: users.id });
  createdUsers.push(user!.id);
  await wallet.credit(ctx, { userId: user!.id, amount, refType: 'topup', refId: tag() });
  const raw = `ag_${randomUUID().replace(/-/g, '')}`;
  const { apiKeys } = await import('@ai-gateway/db');
  const [key] = await db
    .insert(apiKeys)
    .values({ keyHash: createHash('sha256').update(raw).digest('hex'), keyPreview: 'ag_****', userId: user!.id, name: 'v2gp' })
    .returning({ id: apiKeys.id });
  createdKeys.push(key!.id);
  return { raw, userId: user!.id, apiKeyId: key!.id };
}

interface StubSpec {
  failTimes?: number;
  usage?: { inputTokens: number; cachedInputTokens: number; outputTokens: number; cacheWriteTokens?: number };
  deadCredential?: boolean;
  /** 成功响应体覆盖（images 计量实值取 data.length） */
  body?: Record<string, unknown>;
  /** 流式剧本：帧文本数组 + 终态（usage 可缺 → 估算路径；doubleFireSuccess=success 事件重入） */
  stream?: { frames: string[]; usage?: { inputTokens: number; cachedInputTokens: number; outputTokens: number }; terminated?: string; bytesRelayed?: number; doubleFireSuccess?: boolean; slowTerminalMs?: number };
}

/** stub 上游：按渠道名全名键控（跨模型多组渠道互不冲突） */
function stubUpstream(plan: Record<string, StubSpec>): UpstreamPort {
  const attempts = new Map<string, number>();
  return {
    async chat(candidate, request): Promise<UpstreamResult> {
      void request;
      const spec = plan[candidate.channelName] ?? {};
      const tried = attempts.get(candidate.channelName) ?? 0;
      attempts.set(candidate.channelName, tried + 1);
      if ((tried < (spec.failTimes ?? 0)) || spec.deadCredential === true) {
        return {
          ok: false,
          error: spec.deadCredential
            ? { code: 'invalid_api_key', message: 'dead credential', deadCredential: true }
            : { code: 'upstream_error', message: `boom-${candidate.channelName}` },
        };
      }
      return {
        ok: true,
        body: spec.body ?? { id: 'chatcmpl-stub', choices: [{ message: { role: 'assistant', content: `from-${candidate.channelName.slice(0, 6)}` } }] },
        ...(spec.usage ? { usage: spec.usage } : {}),
      };
    },
    async chatStream(candidate, request) {
      void request;
      const spec = plan[candidate.channelName] ?? {};
      const script = spec.stream;
      const listeners: Array<(e: UpstreamStreamEvent) => void> = [];
      // 端口契约：订阅晚于事件发出时重放（真 ai 包 lateEvents 同语义）
      const emitted: UpstreamStreamEvent[] = [];
      const emit = (e: UpstreamStreamEvent) => {
        emitted.push(e);
        listeners.forEach((cb) => cb(e));
      };
      if (!script) {
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            emit({ type: 'failed', code: 'upstream_error', message: 'no stream script' });
            controller.close();
          },
        });
        return { stream, onEvent: (cb) => { listeners.push(cb); for (const e of emitted) cb(e); } };
      }
      let firstEmitted = false;
      const stream = new ReadableStream<Uint8Array>({
        async start(controller) {
          const encoder = new TextEncoder();
          for (const frame of script.frames) {
            if (!firstEmitted) {
              firstEmitted = true;
              emit({ type: 'first_chunk' });
            }
            controller.enqueue(encoder.encode(frame));
          }
          const success = {
            type: 'success',
            ...(script.usage ? { usage: { ...script.usage, estimated: false } } : {}),
            ...(script.terminated !== undefined ? { terminated: script.terminated } : {}),
            ...(script.bytesRelayed !== undefined ? { bytesRelayed: script.bytesRelayed } : {}),
          } as const;
          emit(success);
          if (script.doubleFireSuccess) emit(success); // 端口极端形态：终态重复投递
          if (script.slowTerminalMs) await new Promise((r) => setTimeout(r, script.slowTerminalMs));
          controller.close();
        },
      });
      return { stream, onEvent: (cb) => { listeners.push(cb); for (const e of emitted) cb(e); } };
    },
  };
}

const config = {
  reservationLimit: '1000',
  authorizationTtlMs: 300_000,
  output: { defaultMax: 4_096, exposureCap: 32_768 },
};
const settlement = createSettlementDomain({
  db, currency: 'CNY', wallet,
  policy: { maxAttempts: 3, baseDelayMs: 100, maxDelayMs: 1_000 },
});

function makeApp(upstream: UpstreamPort) {
  return makeAppWith(config, upstream);
}

function makeAppWith(cfg: typeof config, upstream: UpstreamPort) {
  return createApp({
    db,
    runChat: createRunChat({ db, billing, buildQuote, resolveChannels, upstream, config: cfg }),
    oauth: { jwtSecret: 'gw-test-secret-0123456789abcdef', tokenTtlSeconds: 3_600 },
  });
}

const body = (model: string) => ({
  model,
  messages: [{ role: 'user', content: 'hello gateway v2' }],
});
const streamBody = (model: string) => ({ model, stream: true, messages: [{ role: 'user', content: 'hi' }] });

afterAll(async () => {
  if (createdRequests.length) {
    await db.$client.query('delete from billing_reservations where billing_request_id = any($1::uuid[])', [createdRequests]);
    await db.$client.query('delete from usage_logs where request_id = any($1::uuid[])', [createdRequests]);
    await db.$client.query('delete from billing_requests where request_id = any($1::uuid[])', [createdRequests]);
  }
  if (createdChannels.length) {
    await db.$client.query('delete from model_channels where channel_id = any($1)', [createdChannels]);
    await db.$client.query('delete from channels where id = any($1)', [createdChannels]);
  }
  if (createdMappings.length) await db.$client.query('delete from model_mappings where id = any($1)', [createdMappings]);
  if (createdProviders.length) await db.$client.query('delete from providers where id = any($1)', [createdProviders]);
  if (createdKeys.length) await db.$client.query('delete from api_keys where id = any($1)', [createdKeys]);
  if (createdUsers.length) await db.$client.query('delete from users where id = any($1)', [createdUsers]);
  await db.$client.end().catch(() => {});
});

async function billingRow(requestId: string) {
  const result = await db.$client.query<{ status: string; channel_id: number | null; receipt: Record<string, unknown> | null }>(
    'select status, channel_id, receipt from billing_requests where request_id = $1', [requestId],
  );
  return result.rows[0];
}

async function walletOf(userId: number) {
  const rows = await wallet.accounts(ctx, userId);
  return { balance: rows[0]!.balance, inFlight: rows[0]!.inFlight };
}

describe('runChat 资金编排', () => {
  it('成功链路：预扣 → 预留 → 收据 signal → settlement_pending（余额未动，冻结在途）', async () => {
    const seeded = await seedModelWithChannels([{}]);
    const model = seeded.model;
    const { raw, userId } = await newFundedKey();
    const app = makeApp(stubUpstream({ [seeded.channelNames[0]!]: { usage: { inputTokens: 500, cachedInputTokens: 0, outputTokens: 100 } } }));

    const res = await app.request('/v1/chat/completions', {
      method: 'POST',
      headers: { authorization: `Bearer ${raw}`, 'content-type': 'application/json' },
      body: JSON.stringify(body(model)),
    });
    const json = (await res.json()) as Record<string, unknown>;
    expect(res.status).toBe(200);
    expect(json.choices).toBeDefined();

    const billingRequestId = json.id as string; // 占位——真实链路的 requestId 在 x-request-id
    void billingRequestId;
    // 用钱包与渠道状态断言（requestId 由中间件生成，这里从 DB 侧取证该用户最新账单）
    const found = await db.$client.query<{ request_id: string }>(
      'select request_id from billing_requests where user_id = $1 order by created_at desc limit 1', [userId],
    );
    const requestId = found.rows[0]!.request_id;
    createdRequests.push(requestId);
    const row = await billingRow(requestId);
    expect(row!.status).toBe('settlement_pending');
    expect(Number(row!.channel_id)).toBe(createdChannels.at(-1));
    expect(row!.receipt).toMatchObject({ usage: { inputTokens: 500 } });
    const walletState = await walletOf(userId);
    expect(walletState.balance).toBe('100'); // 冻结非实扣——结算归 worker
    expect(new Decimal(walletState.inFlight).gt(0)).toBe(true);
  });

  it('换渠链路：首渠道可换错误 → 第二渠道成功；旧渠道敞口归还、投影指向新渠道', async () => {
    const seeded = await seedModelWithChannels([{}, {}]);
    const model = seeded.model;
    const { raw, userId } = await newFundedKey();
    const app = makeApp(stubUpstream({
      [seeded.channelNames[0]!]: { failTimes: 99 },
      [seeded.channelNames[1]!]: { usage: { inputTokens: 100, cachedInputTokens: 0, outputTokens: 10 } },
    }));

    const res = await app.request('/v1/chat/completions', {
      method: 'POST',
      headers: { authorization: `Bearer ${raw}`, 'content-type': 'application/json' },
      body: JSON.stringify(body(model)),
    });
    expect(res.status).toBe(200);

    const found = await db.$client.query<{ request_id: string; channel_id: number }>(
      'select request_id, channel_id from billing_requests where user_id = $1 order by created_at desc limit 1', [userId],
    );
    const requestId = found.rows[0]!.request_id;
    createdRequests.push(requestId);
    const channelsSeeded = createdChannels.slice(-2);
    expect(Number(found.rows[0]!.channel_id)).toBe(channelsSeeded[1]); // 投影 = 成功渠道
    const reserved = await db.$client.query<{ id: number; upstream_reserved: string }>(
      'select id, upstream_reserved from channels where id = any($1)', [channelsSeeded],
    );
    const byId = new Map(reserved.rows.map((r) => [Number(r.id), r.upstream_reserved]));
    expect(new Decimal(byId.get(channelsSeeded[0]!)!).isZero()).toBe(true); // 旧渠道敞口归还
    expect(new Decimal(byId.get(channelsSeeded[1]!)!).gt(0)).toBe(true); // 新渠道在途（worker 结算释放）
  });

  it('全败链路：signal(failed) 三路归还——账单 released、钱包在途归零、渠道敞口归零', async () => {
    const seeded = await seedModelWithChannels([{}, {}]);
    const model = seeded.model;
    const { raw, userId } = await newFundedKey();
    const app = makeApp(stubUpstream({
      [seeded.channelNames[0]!]: { failTimes: 99 },
      [seeded.channelNames[1]!]: { failTimes: 99 },
    }));

    const res = await app.request('/v1/chat/completions', {
      method: 'POST',
      headers: { authorization: `Bearer ${raw}`, 'content-type': 'application/json' },
      body: JSON.stringify(body(model)),
    });
    expect(res.status).toBe(502);
    const errBody = (await res.json()) as { error: { code: string } };
    expect(errBody.error.code).toBe('upstream_failed');

    const found = await db.$client.query<{ request_id: string }>(
      'select request_id from billing_requests where user_id = $1 order by created_at desc limit 1', [userId],
    );
    const requestId = found.rows[0]!.request_id;
    createdRequests.push(requestId);
    expect((await billingRow(requestId))!.status).toBe('released');
    const walletState = await walletOf(userId);
    expect(walletState.inFlight).toBe('0');
    expect(walletState.balance).toBe('100');
    const channelsSeeded = createdChannels.slice(-2);
    const reserved = await db.$client.query<{ upstream_reserved: string }>(
      'select upstream_reserved from channels where id = any($1)', [channelsSeeded],
    );
    for (const row of reserved.rows) {
      expect(new Decimal(row.upstream_reserved).isZero()).toBe(true);
    }
  });

  it('跨模型 fallback：主模型全渠道可换失败 → fallback 模型渠道成功，收据用 fallback 快照', async () => {
    const fb = await seedModelWithChannels([{}], { realModel: `real-fb-${tag()}` });
    const main = await seedModelWithChannels([{}], { fallbackModels: [fb.model] });
    const { raw, userId } = await newFundedKey();
    const app = makeApp(stubUpstream({
      [main.channelNames[0]!]: { failTimes: 99 },
      [fb.channelNames[0]!]: { usage: { inputTokens: 200, cachedInputTokens: 0, outputTokens: 20 } },
    }));

    const res = await app.request('/v1/chat/completions', {
      method: 'POST',
      headers: { authorization: `Bearer ${raw}`, 'content-type': 'application/json' },
      body: JSON.stringify(body(main.model)),
    });
    expect(res.status).toBe(200);
    const found = await db.$client.query<{ request_id: string; receipt: Record<string, unknown> }>(
      'select request_id, receipt from billing_requests where user_id = $1 order by created_at desc limit 1', [userId],
    );
    const requestId = found.rows[0]!.request_id;
    createdRequests.push(requestId);
    const receipt = found.rows[0]!.receipt as { realModel: string; channelId: number | string };
    expect(receipt.realModel).toMatch(/^real-fb-/); // 收据 = 实际成功的 fallback 候选
    expect(Number(receipt.channelId)).toBe(createdChannels.at(-2)); // fb 先种子（在 main 之前）
  });

  it('死凭据：渠道落库 status=4 后继续换渠成功', async () => {
    const seeded = await seedModelWithChannels([{}, {}]);
    const { raw, userId } = await newFundedKey();
    const app = makeApp(stubUpstream({
      [seeded.channelNames[0]!]: { deadCredential: true },
      [seeded.channelNames[1]!]: { usage: { inputTokens: 10, cachedInputTokens: 0, outputTokens: 1 } },
    }));

    const res = await app.request('/v1/chat/completions', {
      method: 'POST',
      headers: { authorization: `Bearer ${raw}`, 'content-type': 'application/json' },
      body: JSON.stringify(body(seeded.model)),
    });
    expect(res.status).toBe(200);
    const found = await db.$client.query<{ request_id: string }>(
      'select request_id from billing_requests where user_id = $1 order by created_at desc limit 1', [userId],
    );
    createdRequests.push(found.rows[0]!.request_id);
    const dead = await db.$client.query<{ status: number }>(
      'select status from channels where id = $1', [createdChannels.at(-2)],
    );
    expect(dead.rows[0]!.status).toBe(4); // 死凭据渠道永久退出路由
  });

describe('runChat 流式分支', () => {
  async function latestReceipt(userId: number): Promise<{ request_id: string; receipt: Record<string, unknown> }> {
    const found = await db.$client.query<{ request_id: string; receipt: Record<string, unknown> }>(
      'select request_id, receipt from billing_requests where user_id = $1 order by created_at desc limit 1', [userId],
    );
    createdRequests.push(found.rows[0]!.request_id);
    return found.rows[0]!;
  }

  it('正常流：SSE 帧透传 + 可信 usage 收据（stream=true, streamAborted=false）', async () => {
    const seeded = await seedModelWithChannels([{}]);
    const { raw, userId } = await newFundedKey();
    const app = makeApp(stubUpstream({
      [seeded.channelNames[0]!]: {
        stream: {
          frames: ['data: {"delta":"你"}\n\n', 'data: [DONE]\n\n'],
          usage: { inputTokens: 30, cachedInputTokens: 0, outputTokens: 5 },
        },
      },
    }));

    const res = await app.request('/v1/chat/completions', {
      method: 'POST',
      headers: { authorization: `Bearer ${raw}`, 'content-type': 'application/json' },
      body: JSON.stringify(streamBody(seeded.model)),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    const text = await res.text();
    expect(text).toContain('data: [DONE]');
    await new Promise((r) => setTimeout(r, 50)); // 终态监听异步收尾

    const row = await latestReceipt(userId);
    expect(row.receipt).toMatchObject({
      stream: true,
      streamAborted: false,
      channelId: createdChannels.at(-1),
    });
    expect((row.receipt as { usage: { inputTokens: number; estimated: boolean } }).usage).toMatchObject({ inputTokens: 30, estimated: false });
  });

  it('长流续租：流时长 > 授权租约 TTL 时按 1/3 周期续租（防 recover 误释放→漏收）', async () => {
    const seeded = await seedModelWithChannels([{}]);
    const { raw, userId } = await newFundedKey();
    // TTL 压到 900ms（续租每 450ms）——流持续 1.2s 必须至少续租一次
    const shortTtl = { ...config, authorizationTtlMs: 900 };
    const app = makeAppWith(shortTtl, stubUpstream({
      [seeded.channelNames[0]!]: {
        stream: { frames: ['data: {"a":1}\n\n'], slowTerminalMs: 1_200, usage: { inputTokens: 5, cachedInputTokens: 0, outputTokens: 2 } },
      },
    }));

    const res = await app.request('/v1/chat/completions', {
      method: 'POST',
      headers: { authorization: `Bearer ${raw}`, 'content-type': 'application/json' },
      body: JSON.stringify(streamBody(seeded.model)),
    });
    expect(res.status).toBe(200);
    await res.text();
    const row0 = await latestReceipt(userId);
    createdRequests.push(row0.request_id);

    // 等终态（1.2s 慢终态）——期间租约被续期；未被 recover 误释放则结算不冲突。
    // 回归点是「误释放 → released/dead → 漏收」；开发库可能有活的 worker
    // （默认 1s 一轮）在此窗口合法结算——settled 不是回归，released/dead 才是。
    await new Promise((r) => setTimeout(r, 1_800));
    const lease = await db.$client.query<{ status: string }>(
      'select status from billing_requests where request_id = $1', [row0.request_id],
    );
    expect(['settlement_pending', 'settled']).toContain(lease.rows[0]!.status);
    if (lease.rows[0]!.status === 'settlement_pending') {
      const claims = await settlement.claim(systemContext(randomUUID()), {
        ownerId: tag(), batchSize: 5, claimLeaseMs: 60_000, requestIds: [row0.request_id],
      });
      expect(claims).toHaveLength(1);
      // 共享 dev 库竞态（§5.7）：外部活 worker 可能先结算——retried 也是合法终态
    const outcome = await settlement.processClaim(systemContext(randomUUID()), claims[0]!);
    expect(['settled', 'retried']).toContain(outcome);
    }
  });

  it('终态 double-fire 重入：success 事件重复投递 → 收据幂等只落一次（不双结算）', async () => {
    const seeded = await seedModelWithChannels([{}]);
    const { raw, userId } = await newFundedKey();
    // 剧本：上线后 success 事件 double-fire（端口重放与真实事件叠加的极端形态）
    const app = makeApp(stubUpstream({
      [seeded.channelNames[0]!]: {
        stream: {
          frames: ['data: {"ok":1}\n\n'],
          usage: { inputTokens: 5, cachedInputTokens: 0, outputTokens: 1 },
          doubleFireSuccess: true,
        },
      },
    }));

    const res = await app.request('/v1/chat/completions', {
      method: 'POST',
      headers: { authorization: `Bearer ${raw}`, 'content-type': 'application/json' },
      body: JSON.stringify(streamBody(seeded.model)),
    });
    expect(res.status).toBe(200);
    await res.text();
    const row = await latestReceipt(userId); // 登记清理
    await new Promise((r) => setTimeout(r, 100)); // 两个终态处理都是异步——等第二发落地
    const statusRow = await db.$client.query<{ status: string }>(
      'select status from billing_requests where request_id = $1', [row.request_id],
    );
    expect(statusRow.rows[0]!.status).toBe('settlement_pending'); // 仍是单据态（重放不产生新账单行）
    const count = await db.$client.query<{ n: string }>(
      'select count(*)::text as n from billing_requests where request_id = $1', [row.request_id],
    );
    expect(count.rows[0]!.n).toBe('1'); // 同 requestId 恒一行（幂等键结构性防双账）
  });

  it('客户端取消：terminated=client_disconnect → 估算收据（estimatedFor=client_disconnect, bytesRelayed）', async () => {
    const seeded = await seedModelWithChannels([{}]);
    const { raw, userId } = await newFundedKey();
    const app = makeApp(stubUpstream({
      [seeded.channelNames[0]!]: {
        stream: { frames: ['data: {"delta":"部"}\n\n'], terminated: 'client_disconnect', bytesRelayed: 42 },
      },
    }));

    const res = await app.request('/v1/chat/completions', {
      method: 'POST',
      headers: { authorization: `Bearer ${raw}`, 'content-type': 'application/json' },
      body: JSON.stringify(streamBody(seeded.model)),
    });
    expect(res.status).toBe(200);
    await res.text();
    await new Promise((r) => setTimeout(r, 50));

    const row = await latestReceipt(userId);
    expect(row.receipt).toMatchObject({
      estimatedFor: 'client_disconnect',
      bytesRelayed: 42,
      streamAborted: true,
    });
    const usage = (row.receipt as { usage: { estimated: boolean } }).usage;
    expect(usage.estimated).toBe(true);
  });

  it('first_chunk 前失败：与非流式同语义换渠（第二渠道上线）', async () => {
    const seeded = await seedModelWithChannels([{}, {}]);
    const { raw, userId } = await newFundedKey();
    const app = makeApp(stubUpstream({
      [seeded.channelNames[0]!]: { failTimes: 99 },
      [seeded.channelNames[1]!]: {
        stream: { frames: ['data: {"ok":true}\n\n'], usage: { inputTokens: 8, cachedInputTokens: 0, outputTokens: 2 } },
      },
    }));

    const res = await app.request('/v1/chat/completions', {
      method: 'POST',
      headers: { authorization: `Bearer ${raw}`, 'content-type': 'application/json' },
      body: JSON.stringify(streamBody(seeded.model)),
    });
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).not.toContain('[DONE]'); // 第二渠道脚本只有一帧
    expect(text).toContain('ok');
    await latestReceipt(userId); // 登记清理
  });
});

  it('余额不足：402 信封，账单零落', async () => {
    const seeded = await seedModelWithChannels([{}]);
    const model = seeded.model;
    const [user] = await db
      .insert(users)
      .values({ issuer: 'v2gp', subject: `v2gp-${randomUUID()}`, identityProvider: 'local' })
      .returning({ id: users.id });
    createdUsers.push(user!.id);
    const raw = `ag_${randomUUID().replace(/-/g, '')}`;
    const { apiKeys } = await import('@ai-gateway/db');
    const [key] = await db
      .insert(apiKeys)
      .values({ keyHash: createHash('sha256').update(raw).digest('hex'), keyPreview: 'ag_****', userId: user!.id, name: 'v2gp' })
      .returning({ id: apiKeys.id });
    createdKeys.push(key!.id);
    const app = makeApp(stubUpstream({}));

    const res = await app.request('/v1/chat/completions', {
      method: 'POST',
      headers: { authorization: `Bearer ${raw}`, 'content-type': 'application/json' },
      body: JSON.stringify(body(model)),
    });
    expect(res.status).toBe(402);
    const count = await db.$client.query<{ n: string }>('select count(*)::text as n from billing_requests where user_id = $1', [user!.id]);
    expect(count.rows[0]!.n).toBe('0');
  });
});

describe('runChat 单位计费（计量注册表接线）', () => {
  it('音频按秒：预扣 = ceil(audioSeconds) × 单价（修复前恒押 1 秒）；收据 units = 秒实值', async () => {
    const seeded = await seedModelWithChannels([{}], {
      pricing: { pricingUnit: 'second', unitPrice: '0.5', inputPrice: '0', outputPrice: '0', cacheInputPrice: '0' },
    });
    const { userId, apiKeyId } = await newFundedKey();
    const runChat = createRunChat({
      db, billing, buildQuote, resolveChannels,
      upstream: stubUpstream({ [seeded.channelNames[0]!]: {} }), // 音频上游无 token usage → 估算收据
      config,
    });

    const audioCtx = systemContext(randomUUID());
    const result = await runChat(audioCtx, { userId, apiKeyId, appId: null, allowedModels: null, userRpmLimit: null, userTpmLimit: null, rpmLimit: null, tpmLimit: null  }, {
      model: seeded.model,
      audioSeconds: 90.4,
    } as unknown as ChatCompletionBody, 'audio_transcription');
    expect(result.status).toBe(200);

    createdRequests.push(audioCtx.requestId);
    const row = await billingRow(audioCtx.requestId);
    expect(row!.status).toBe('settlement_pending');
    expect(row!.receipt).toMatchObject({ usage: { units: 91, estimated: true } });
    expect(new Decimal(String(row!.receipt!.unitPrice)).eq('0.5')).toBe(true); // numeric 列尾零归一
    const walletState = await walletOf(userId);
    expect(walletState.balance).toBe('100'); // 冻结非实扣
    expect(new Decimal(walletState.inFlight).eq('45.5')).toBe(true); // 91s × 0.5 元/s
  });

  it('图片按张 + 变体单价：收据 units = 响应张数、unitPrice = 变体命中；结算实扣（修复前恒 0 元）', async () => {
    const seeded = await seedModelWithChannels([{}], {
      pricing: {
        pricingUnit: 'image', unitPrice: '1',
        inputPrice: '0', outputPrice: '0', cacheInputPrice: '0',
        billingConfig: { strategy: 'variant', params: { selector: 'size', prices: { '1024x1024': '0.8', '1792x1024': '2' } } },
      },
    });
    const { userId, apiKeyId } = await newFundedKey();
    const runChat = createRunChat({
      db, billing, buildQuote, resolveChannels,
      upstream: stubUpstream({ [seeded.channelNames[0]!]: { body: { data: [{ url: 'a' }, { url: 'b' }] } } }),
      config,
    });

    const imageCtx = systemContext(randomUUID());
    const result = await runChat(imageCtx, { userId, apiKeyId, appId: null, allowedModels: null, userRpmLimit: null, userTpmLimit: null, rpmLimit: null, tpmLimit: null  }, {
      model: seeded.model,
      prompt: 'a cat',
      n: 2,
      size: '1024x1024',
    } as unknown as ChatCompletionBody, 'images');
    expect(result.status).toBe(200);

    createdRequests.push(imageCtx.requestId);
    const row = await billingRow(imageCtx.requestId);
    expect(row!.status).toBe('settlement_pending');
    expect(row!.receipt).toMatchObject({ unitPrice: '0.8', usage: { units: 2, estimated: true } });

    // 走真结算（claim 定向本请求）：钱包实扣 2 张 × 0.8 = 1.6，在途清零
    const scopedSettlement = createSettlementDomain({
      db, currency: 'CNY', wallet,
      policy: { maxAttempts: 3, baseDelayMs: 100, maxDelayMs: 1_000 },
    });
    const claims = await scopedSettlement.claim(systemContext(randomUUID()), {
      ownerId: 'v2gp-settle', batchSize: 5, claimLeaseMs: 60_000, requestIds: [imageCtx.requestId],
    });
    expect(claims).toHaveLength(1);
    const outcome = await scopedSettlement.processClaim(systemContext(randomUUID()), claims[0]!);
    expect(outcome).toBe('settled');
    const walletState = await walletOf(userId);
    expect(new Decimal(walletState.balance).eq('98.4')).toBe(true);
    expect(new Decimal(walletState.inFlight).eq('0')).toBe(true);
  });
});

describe('runChat 预扣策略（billing_config.reservation 数据驱动）', () => {
  /** 低余额用户（不走 newFundedKey 的 100 元）：amount 可指定 */
  async function newUserWithBalance(amount: string): Promise<{ userId: number; apiKeyId: number; raw: string }> {
    const [user] = await db
      .insert(users)
      .values({ issuer: 'v2gp', subject: `v2gp-${randomUUID()}`, identityProvider: 'local' })
      .returning({ id: users.id });
    createdUsers.push(user!.id);
    await wallet.credit(ctx, { userId: user!.id, amount, refType: 'topup', refId: tag() });
    const raw = `ag_${randomUUID().replace(/-/g, '')}`;
    const { apiKeys } = await import('@ai-gateway/db');
    const [key] = await db
      .insert(apiKeys)
      .values({ keyHash: createHash('sha256').update(raw).digest('hex'), keyPreview: 'ag_****', userId: user!.id, name: 'v2gp' })
      .returning({ id: apiKeys.id });
    createdKeys.push(key!.id);
    return { userId: user!.id, apiKeyId: key!.id, raw };
  }

  it('文本模型 balanceFloor：余额 0.15 ≥ 阈值 0.1 即放行（预估 24 元不再 402），hold 封顶实筹', async () => {
    // 输出价 6000 元/M × 上界 4096 token ≈ 24.6 元保守预估 ≫ 余额
    const seeded = await seedModelWithChannels([{}], {
      pricing: {
        inputPrice: '0', outputPrice: '6000', cacheInputPrice: '0',
        billingConfig: { reservation: { strategy: 'floor', params: { balance: '0.1' } } },
      },
    });
    const runChat = createRunChat({
      db, billing, buildQuote, resolveChannels,
      upstream: stubUpstream({ [seeded.channelNames[0]!]: { usage: { inputTokens: 5, cachedInputTokens: 0, outputTokens: 10 } } }),
      config,
    });

    const lowCtx = systemContext(randomUUID());
    const { userId, apiKeyId } = await newUserWithBalance('0.15');
    const result = await runChat(lowCtx, { userId, apiKeyId, appId: null, allowedModels: null, userRpmLimit: null, userTpmLimit: null, rpmLimit: null, tpmLimit: null  }, body(seeded.model), 'chat');
    expect(result.status).toBe(200);
    createdRequests.push(lowCtx.requestId);
    const row = await billingRow(lowCtx.requestId);
    expect(row!.status).toBe('settlement_pending');
    const walletState = await walletOf(userId);
    expect(walletState.balance).toBe('0.15'); // 冻结非实扣
    expect(new Decimal(walletState.inFlight).eq('0.15')).toBe(true); // hold = 实筹封顶，敞口结算兜底
  });

  it('文本模型 balanceFloor：余额 0.05 < 阈值 0.1 → 402 拒绝（不免费放行）', async () => {
    const seeded = await seedModelWithChannels([{}], {
      pricing: {
        inputPrice: '0', outputPrice: '6000', cacheInputPrice: '0',
        billingConfig: { reservation: { strategy: 'floor', params: { balance: '0.1' } } },
      },
    });
    const app = makeApp(stubUpstream({}));
    const { userId, raw } = await newUserWithBalance('0.05');
    const res = await app.request('/v1/chat/completions', {
      method: 'POST',
      headers: { authorization: `Bearer ${raw}`, 'content-type': 'application/json' },
      body: JSON.stringify(body(seeded.model)),
    });
    expect(res.status).toBe(402);
    const count = await db.$client.query<{ n: string }>('select count(*)::text as n from billing_requests where user_id = $1', [userId]);
    expect(count.rows[0]!.n).toBe('0');
  });

  it('视频 unitFloor：duration=4 但保底 5 秒 → 预扣 5×单价；结算实值仍按真实 4 秒', async () => {
    const seeded = await seedModelWithChannels([{}], {
      pricing: {
        pricingUnit: 'second', unitPrice: '0.5',
        inputPrice: '0', outputPrice: '0', cacheInputPrice: '0',
        billingConfig: { reservation: { strategy: 'floor', params: { units: 5 } } },
      },
    });
    const { userId, apiKeyId } = await newUserWithBalance('100');
    const runChat = createRunChat({
      db, billing, buildQuote, resolveChannels,
      upstream: stubUpstream({ [seeded.channelNames[0]!]: {} }),
      config,
    });

    const videoCtx = systemContext(randomUUID());
    const result = await runChat(videoCtx, { userId, apiKeyId, appId: null, allowedModels: null, userRpmLimit: null, userTpmLimit: null, rpmLimit: null, tpmLimit: null  }, {
      model: seeded.model,
      duration: 4,
    } as unknown as ChatCompletionBody, 'video');
    expect(result.status).toBe(200);
    createdRequests.push(videoCtx.requestId);
    const row = await billingRow(videoCtx.requestId);
    expect(row!.status).toBe('settlement_pending');
    expect(row!.receipt).toMatchObject({ usage: { units: 4 } }); // 结算实值不受保底抬高
    const walletState = await walletOf(userId);
    expect(new Decimal(walletState.inFlight).eq('2.5')).toBe(true); // 保底 5s × 0.5 元/s
  });

  it('balanceFloor 封顶单经真结算：投影==Σ明细（修复前必死信冻结押金）', async () => {
    // 估价 24.6 元 ≫ 余额 0.15 → floor 0.1 放行、hold 封顶 0.15；
    // 结算不变量 Σ明细==reserved_amount 要求投影同封顶（E2E ⑭ 抓获的真 bug 回归）
    const seeded = await seedModelWithChannels([{}], {
      pricing: {
        inputPrice: '0', outputPrice: '6000', cacheInputPrice: '0',
        billingConfig: { reservation: { strategy: 'floor', params: { balance: '0.1' } } },
      },
    });
    const { userId, apiKeyId } = await newFundedKey('0.15');
    const runChat = createRunChat({
      db, billing, buildQuote, resolveChannels,
      upstream: stubUpstream({ [seeded.channelNames[0]!]: { usage: { inputTokens: 10, cachedInputTokens: 0, outputTokens: 5 } } }),
      config,
    });

    const floorCtx = systemContext(randomUUID());
    const result = await runChat(floorCtx, { userId, apiKeyId, appId: null, allowedModels: null, userRpmLimit: null, userTpmLimit: null, rpmLimit: null, tpmLimit: null  }, body(seeded.model), 'chat');
    expect(result.status).toBe(200);
    createdRequests.push(floorCtx.requestId);

    const scopedSettlement = createSettlementDomain({
      db, currency: 'CNY', wallet,
      policy: { maxAttempts: 3, baseDelayMs: 100, maxDelayMs: 1_000 },
    });
    const claims = await scopedSettlement.claim(systemContext(randomUUID()), {
      ownerId: tag(), batchSize: 5, claimLeaseMs: 60_000, requestIds: [floorCtx.requestId],
    });
    expect(claims).toHaveLength(1);
    expect(await scopedSettlement.processClaim(systemContext(randomUUID()), claims[0]!)).toBe('settled'); // 不再 dead
    const walletState = await walletOf(userId);
    expect(new Decimal(walletState.inFlight).eq('0')).toBe(true); // 押金解冻
    expect(new Decimal(walletState.balance).eq('0.12')).toBe(true); // 0.15 − 5 token × 6000/1M = 0.03 实扣
  });

  it('未声明 reservation（缺省 full）：余额不足保守预估仍 402——现行语义零变更', async () => {
    const seeded = await seedModelWithChannels([{}], {
      pricing: { inputPrice: '0', outputPrice: '6000', cacheInputPrice: '0' },
    });
    const app = makeApp(stubUpstream({}));
    const { userId, raw } = await newUserWithBalance('0.15');
    const res = await app.request('/v1/chat/completions', {
      method: 'POST',
      headers: { authorization: `Bearer ${raw}`, 'content-type': 'application/json' },
      body: JSON.stringify(body(seeded.model)),
    });
    expect(res.status).toBe(402);
    const count = await db.$client.query<{ n: string }>('select count(*)::text as n from billing_requests where user_id = $1', [userId]);
    expect(count.rows[0]!.n).toBe('0');
  });
});

describe('终审修复回归（限流维度并罚 / 收据归属 / 终态重试）', () => {
  it('App-JWT 并罚维度：scope 挂 app 维、管理端用户帽挂 user 维（修复前 JWT 路径用户帽整族失效）', async () => {
    const seeded = await seedModelWithChannels([{}]);
    const { userId } = await newFundedKey();
    const recorded: Array<{ dimension: string; max: number }> = [];
    const succeeded: UsageReceipt[] = [];
    const realSignal = billing.signal.bind(billing);
    const billingProbe = {
      ...billing,
      signal: (c: Parameters<typeof billing.signal>[0], event: Parameters<typeof billing.signal>[1]) => {
        if (event.type === 'request.succeeded') succeeded.push(event.receipt);
        return realSignal(c, event);
      },
    } as typeof billing;
    const gate = {
      limiter: {
        checkAll: async (dims: Array<{ dimension: string; max: number }>) => { recorded.push(...dims); return { allowed: true }; },
        reserveTpmAll: async (dims: Array<{ dimension: string; max: number }>) => { recorded.push(...dims); return { allowed: true }; },
        releaseTpm: async () => {},
      },
      freeDaily: { check: async () => ({ ok: true }) },
      globalRpm: null,
    } as unknown as RateLimitGate;
    const reqId = randomUUID();
    createdRequests.push(reqId);
    const runChat = createRunChat({
      db, billing: billingProbe, buildQuote, resolveChannels,
      upstream: stubUpstream({ [seeded.channelNames[0]!]: { usage: { inputTokens: 10, cachedInputTokens: 0, outputTokens: 5 } } }),
      config, rateLimit: gate,
    });
    const res = await runChat(systemContext(reqId), {
      userId, apiKeyId: null, appId: 7,
      rpmLimit: 1000, tpmLimit: null, userRpmLimit: 2, userTpmLimit: null, allowedModels: null,
    }, body(seeded.model), 'chat');
    expect(res.status).toBe(200);
    expect(recorded).toContainEqual({ dimension: 'app:7', max: 1000 }); // scope 限额 → app 维
    expect(recorded).toContainEqual({ dimension: `user:${userId}`, max: 2 }); // 用户帽 → user 维（修复前缺失）
    expect(recorded.some((d) => d.dimension.startsWith('key:'))).toBe(false);
    // 收据归属（修复前 appId 漏传 → usage_logs.appId 恒 null、credentialType 恒 key）
    expect(succeeded[0]!.appId).toBe(7);
    expect(succeeded[0]!.credentialType).toBe('jwt');
  });

  it('终态 signal 退避重试（纯编排）：两败一成自愈；全败返回 false 交兜底', async () => {
    let calls = 0;
    const flaky = { signal: async () => {
      calls += 1;
      if (calls <= 2) throw new Error('db blip');
      return { changed: true, status: 'settlement_pending', replayed: false };
    } } as unknown as BillingDomain;
    expect(await signalSucceededWithRetry(flaky, ctx, 'req-x', {} as UsageReceipt, () => {}, { attempts: 3, baseDelayMs: 1 })).toBe(true);
    expect(calls).toBe(3);
    let deadCalls = 0;
    const down = { signal: async () => { deadCalls += 1; throw new Error('down'); } } as unknown as BillingDomain;
    expect(await signalSucceededWithRetry(down, ctx, 'req-x', {} as UsageReceipt, () => {}, { attempts: SIGNAL_FINALIZE_ATTEMPTS, baseDelayMs: 1 })).toBe(false);
    expect(deadCalls).toBe(SIGNAL_FINALIZE_ATTEMPTS);
  });

  it('流式终态 signal 瞬时失败：重试期间租约保持、二度落账成功（修复前一次 DB 抖动 → recover 释放 = 免费单）', async () => {
    const seeded = await seedModelWithChannels([{}]);
    const { userId } = await newFundedKey();
    let calls = 0;
    const realSignal = billing.signal.bind(billing);
    const flaky = {
      ...billing,
      signal: (c: Parameters<typeof billing.signal>[0], event: Parameters<typeof billing.signal>[1]) => {
        if (event.type === 'request.succeeded') {
          calls += 1;
          if (calls === 1) return Promise.reject(new Error('db blip'));
        }
        return realSignal(c, event);
      },
    } as typeof billing;
    const reqId = randomUUID();
    createdRequests.push(reqId);
    const runChat = createRunChat({
      db, billing: flaky, buildQuote, resolveChannels,
      upstream: stubUpstream({
        [seeded.channelNames[0]!]: { stream: { frames: ['data: {"delta":"hi"}\n\n'], usage: { inputTokens: 100, cachedInputTokens: 0, outputTokens: 10 } } },
      }),
      config,
    });
    const res = await runChat(systemContext(reqId), {
      userId, apiKeyId: null, appId: null,
      rpmLimit: null, tpmLimit: null, userRpmLimit: null, userTpmLimit: null, allowedModels: null,
    }, streamBody(seeded.model), 'chat');
    expect(res.status).toBe(200);
    await new Promise((r) => setTimeout(r, 1_300)); // 首败 500ms 退避 → 第二次成功
    expect(calls).toBe(2);
    const row = await billingRow(reqId);
    expect(row!.status).toBe('settlement_pending'); // 落账成功（修复前停留 in_flight）
  });
});

describe('任务词表一致性（ai ProtocolTaskKind ↔ domain GENERATION_KINDS）', () => {
  it('两表任务族词表与执行模型一致（跨包单一真相锁死）', async () => {
    const { GENERATION_KINDS: domainKinds, isGenerationTaskKind } = await import('@ai-gateway/domain');
    const domainTaskKinds = Object.entries(domainKinds)
      .filter(([, d]) => d.execution !== undefined)
      .map(([k]) => k);
    // ai 侧任务面词表：video/music（ProtocolTaskKind），执行模型语义与 domain 对齐
    const protocolTaskKinds: Array<'video' | 'music'> = ['video', 'music'];
    for (const kind of protocolTaskKinds) {
      expect(isGenerationTaskKind(kind), `${kind} 必须在 domain 词表中`).toBe(true);
      expect(domainKinds[kind as keyof typeof domainKinds]).toBeDefined();
    }
    expect(domainTaskKinds.toSorted()).toEqual([...protocolTaskKinds].toSorted());
  });
});

describe('cache_write 计费全链（0063：系数体系 + 三分段互斥）', () => {
  it('上游 usage 带 cache_write_tokens → 收据含写分量、结算金额三段计价、usage_logs 落列', async () => {
    const seeded = await seedModelWithChannels([{}], {
      pricing: { inputPrice: '1', outputPrice: '2', cacheInputPrice: '0.5', cacheWritePrice: '1.25' },
    });
    // 请求时点汇率快照：种一行 auto 基准（repos.fx.current 命中 → 收据与 usage_logs 落列）
    await db.insert(fxRates).values({ rate: '7.2', source: 'ecb', mode: 'auto' });
    const { raw, userId } = await newFundedKey('100');
    const app = makeApp(stubUpstream({
      [seeded.channelNames[0]!]: {
        usage: { inputTokens: 1000, cachedInputTokens: 200, outputTokens: 50, cacheWriteTokens: 100 },
      },
    }));
    const res = await app.request('/v1/chat/completions', {
      method: 'POST',
      headers: { authorization: `Bearer ${raw}`, 'content-type': 'application/json' },
      body: JSON.stringify(body(seeded.model)),
    });
    expect(res.status).toBe(200);
    const found = await db.$client.query<{ request_id: string }>(
      'select request_id from billing_requests where user_id = $1 order by created_at desc limit 1', [userId],
    );
    const requestId = found.rows[0]!.request_id;
    createdRequests.push(requestId);
    const row = await billingRow(requestId);
    expect(row!.status).toBe('settlement_pending');
    expect(row!.receipt).toMatchObject({
      usage: { inputTokens: 1000, cachedInputTokens: 200, cacheWriteTokens: 100 },
      cacheWritePrice: '1.250000000000000000', // PG numeric 尾零原样
      fxRate: '7.2',
    });
    expect(row!.receipt!.fxRateId!).toBeGreaterThan(0);
    // 真结算：700×1 + 200×0.5 + 100×1.25 + 50×2 = 1025 → 0.001025 元
    const claims = await settlement.claim(systemContext(randomUUID()), {
      ownerId: `cw-${tag()}`, batchSize: 10, claimLeaseMs: 60_000, requestIds: [requestId],
    });
    // 共享 dev 库竞态（§5.7）：外部活 worker 抢领会致冲突回 retry_wait——
    // 轮询等任一 worker 终态化（本测试或外部，公式同一真相）
    await settlement.processClaim(systemContext(randomUUID()), claims[0]!);
    for (let i = 0; i < 20 && (await billingRow(requestId))!.status !== 'settled'; i++) {
      await new Promise((r) => setTimeout(r, 500));
    }
    const walletState = await walletOf(userId);
    expect(new Decimal(walletState.balance).eq('99.998975')).toBe(true);
    expect(new Decimal(walletState.inFlight).eq('0')).toBe(true);
    const log = await db.$client.query(
      'select cache_write_tokens, cache_write_price from usage_logs where request_id = $1', [requestId],
    );
    expect(Number(log.rows[0].cache_write_tokens)).toBe(100);
    expect(new Decimal(log.rows[0].cache_write_price).eq('1.25')).toBe(true);
  }, 30_000);
});
