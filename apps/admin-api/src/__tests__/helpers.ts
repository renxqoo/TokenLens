/**
 * 集成测试公共基建：真 PG（随机标识隔离）+ 真实会话链（种子管理员 + 签发
 * Bearer token——session 中间件全链路生效）+ 供应商/渠道/映射/费率卡造数
 * + 反向 FK 统一清理。探针/目录源在测试内注入桩。
 */
import { randomUUID } from 'node:crypto';
import { ilike, inArray } from 'drizzle-orm';
import { afterAll } from 'vitest';
import type { Ai } from '@ai-gateway/ai';
import { createDb } from '@ai-gateway/db';
import {
  admins,
  apiKeys,
  channelRecharges,
  channels,
  modelChannels,
  modelMappings,
  plans,
  providers,
  rateCardCoefficients,
  rateCards,
  redeemBatches,
  redeemCodes,
  requestLogs,
  usageLogs,
  userSubscriptions,
  users,
} from '@ai-gateway/db';
import type { Db } from '@ai-gateway/repository';
import { hashPassword } from '@ai-gateway/identity-core';
import { signSession, type Mailer } from '@ai-gateway/identity';
import { createWallet } from '@ai-gateway/service';
import { assembleAdminApi } from '../assembly.js';
import { createAdminAuthService } from '../services/auth.service.js';
import { createApp } from '../app.js';
import type { AdminApiConfig } from '../config.js';
import { createCatalogService, type CatalogSource } from '../services/catalog.service.js';
import { createFxService } from '../services/fx.service.js';
import { createModelsService } from '../services/models.service.js';
import { createChannelsService } from '../services/channels.service.js';

export const db: Db = createDb(
  process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/ai_gateway',
  { poolMax: 5 },
);

/** 与装配同口径的 wallet（fail-closed 白名单 = 管理面三类业务域） */
export const wallet = createWallet({
  db,
  currency: 'CNY',
  guards: {
    refTypes: ['admin', 'subscription', 'pack'],
    currencies: ['CNY'],
    internalAccounts: ['outside', 'platform_revenue'],
  },
});

export const TEST_JWT_SECRET = 'admin-api-test-jwt-secret';
export const TEST_ENCRYPTION_KEY = 'a'.repeat(32);
export const TEST_PASSWORD = 'correct-horse-battery';

/** 与生产装配同构的测试配置（全部可变值显式注入；Redis/SMTP 缺席 = 开发形态） */
export function testConfig(overrides: Partial<AdminApiConfig> = {}): AdminApiConfig {
  return {
    DATABASE_URL: 'postgres://unused',
    PORT: 0,
    DB_POOL_MAX: 5,
    ADMIN_JWT_SECRET: TEST_JWT_SECRET,
    SESSION_TTL_SECONDS: 3_600,
    ENCRYPTION_KEY: TEST_ENCRYPTION_KEY,
    LOGIN_FAILURE_THRESHOLD: 5,
    LOGIN_FAILURE_WINDOW_S: 600,
    LOGIN_LOCK_S: 600,
    LOGIN_IP_FAILURE_LIMIT: 50,
    LOGIN_IP_FAILURE_WINDOW_S: 300,
    ALLOW_LOCAL_UPSTREAM: false,
    CHANNEL_IMPORT_MAX: 1000,
    CATALOG_FREE_CHANNEL_RPM: 20,
    CATALOG_FREE_CHANNEL_BUDGET: '1000000',
    CATALOG_CACHE_TTL_MS: 600_000,
    SMTP_PORT: 465,
    ADMIN_CURRENCY: 'CNY',
    VOUCHER_MAX_BYTES: 2_097_152,
    VOUCHER_DIR: '/tmp/aav2-test-vouchers',
    REDIS_URL: process.env.REDIS_URL ?? 'redis://localhost:6379',
    CORS_ORIGINS: '',
    BODY_LIMIT_BYTES: 1_048_576,
    ADMIN_SHUTDOWN_GRACE_MS: 1_000,
    OTEL_TRACES_MODE: 'off',
    OTEL_EXPORTER_OTLP_ENDPOINT: undefined,
    TRUSTED_PROXY_HOPS: 0,
    ...overrides,
  };
}

export interface TestRequest {
  (
    path: string,
    init?: {
      method?: string;
      body?: unknown;
      /** Bearer token（省略 = 匿名请求；null 亦同） */
      token?: string | null;
      headers?: Record<string, string>;
    },
  ): Promise<Response>;
}

export interface TestApp {
  app: ReturnType<typeof createApp>;
  request: TestRequest;
}

/** 捕获发信的桩 mailer（2FA HTTP 链用） */
export function capturingMailer(): { mailer: Mailer; sent: Array<{ to: string; code: string }> } {
  const sent: Array<{ to: string; code: string }> = [];
  const mailer: Mailer = {
    async sendLoginCode(to, code) {
      sent.push({ to, code });
    },
    async send() {},
  };
  return { mailer, sent };
}

/** 组装真实 app（目录源/探针 Ai/CORS 白名单/mailer 可注入；Redis/SMTP 缺席 = 开发形态语义） */
/** 固定汇率夹具：1 USD = 7.2 CNY（ECB 形状） */
export const MOCK_FX_RATE = '7.2';
const mockFxFetch: typeof fetch = async () =>
  new Response(JSON.stringify({ rates: { CNY: Number(MOCK_FX_RATE) } }), { status: 200 });

export function buildTestApp(
  opts: {
    sources?: readonly CatalogSource[];
    createTester?: () => Ai;
    corsOrigins?: string[];
    mailer?: Mailer | null;
  } = {},
): TestApp {
  const config = testConfig();
  const assembly = assembleAdminApi(config, db);
  if (opts.mailer !== undefined) {
    // 2FA HTTP 面：auth 服务重建（challenger 依赖 mailer）
    assembly.auth = createAdminAuthService({
      db,
      jwtSecret: config.ADMIN_JWT_SECRET,
      sessionTtlSeconds: config.SESSION_TTL_SECONDS,
      loginGuard: openKeyGuard,
      ipGuard: openIpGuard,
      mailer: opts.mailer,
    });
  }
  if (opts.createTester) {
    const tester = opts.createTester;
    assembly.models = createModelsService({
      db,
      redis: null,
      encryptionKey: config.ENCRYPTION_KEY,
      createTester: tester,
    });
    assembly.channels = createChannelsService({
      db,
      redis: null,
      encryptionKey: config.ENCRYPTION_KEY,
      importMax: config.CHANNEL_IMPORT_MAX,
      createTester: tester,
    });
  }
  // fx 固定汇率（不打真 ECB；预填/比价/diff 断言确定性——覆盖默认装配的真 fetch）
  assembly.fx = createFxService({ db, fetchImpl: mockFxFetch });
  if (opts.sources) {
    assembly.catalog = createCatalogService({
      db,
      redis: null,
      sources: opts.sources,
      cacheTtlMs: config.CATALOG_CACHE_TTL_MS,
      freeChannelRpm: config.CATALOG_FREE_CHANNEL_RPM,
      freeChannelBudget: config.CATALOG_FREE_CHANNEL_BUDGET,
      encryptionKey: config.ENCRYPTION_KEY,
      fx: assembly.fx,
    });
  }
  const app = createApp({
    db,
    assembly,
    jwtSecret: config.ADMIN_JWT_SECRET,
    corsOrigins: opts.corsOrigins ?? [],
    bodyLimitBytes: config.BODY_LIMIT_BYTES,
    trustedProxyHops: config.TRUSTED_PROXY_HOPS,
  });
  const request: TestRequest = async (path, init = {}) => {
    const headers: Record<string, string> = { ...init.headers };
    if (init.body !== undefined) headers['content-type'] = 'application/json';
    if (init.token) headers.authorization = `Bearer ${init.token}`;
    return app.request(path, {
      method: init.method ?? (init.body !== undefined ? 'POST' : 'GET'),
      headers,
      body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
    });
  };
  return { app, request };
}

const createdAdmins: number[] = [];
const createdProviders: number[] = [];
const createdChannels: number[] = [];
const createdMappings: number[] = [];
const createdCards: number[] = [];
const createdUsers: number[] = [];
const createdPlans: number[] = [];
const createdApiKeys: number[] = [];
const createdBatches: number[] = [];

export const uid = (tag: string): string => `aav2-${tag}-${randomUUID().slice(0, 8)}`;

/** 恒放行的防护替身（服务依赖已必填；需要真实锁定语义的测试自建 guard） */
export const openKeyGuard = {
  isLocked: async () => ({ locked: false, retryAfterSec: 0 }),
  recordFailure: async () => ({ locked: false, retryAfterSec: 0 }),
  recordSuccess: async () => undefined,
} as const;

export const openIpGuard = {
  isLocked: async () => ({ locked: false, retryAfterSec: 0 }),
  recordFailure: async () => ({ locked: false, retryAfterSec: 0 }),
} as const;
export const adminEmail = (): string => `${uid('admin')}@example.com`;

/** 种子管理员（真实 scrypt 哈希）+ 签发 Bearer 会话（session 中间件全链路吃这个 token） */
export async function newAdmin(opts: { twoFactorEnabled?: boolean } = {}): Promise<{
  id: number;
  email: string;
  token: string;
}> {
  const mail = adminEmail();
  const [row] = await db
    .insert(admins)
    .values({
      email: mail,
      displayName: 'test-admin',
      passwordHash: await hashPassword(TEST_PASSWORD),
      twoFactorEnabled: opts.twoFactorEnabled ?? false,
    })
    .returning({ id: admins.id });
  createdAdmins.push(row!.id);
  const token = await signSession({ type: 'admin', id: row!.id }, TEST_JWT_SECRET);
  return { id: row!.id, email: mail, token };
}

// ── 直插造数（走服务路径的行为在各自主测试里覆盖）──

export async function newProviderRow(): Promise<number> {
  const [row] = await db
    .insert(providers)
    .values({ name: uid('prov'), protocol: 'openai-compatible', baseUrl: 'https://example.com/v1' })
    .returning({ id: providers.id });
  createdProviders.push(row!.id);
  return row!.id;
}

export async function newChannelRow(
  providerId: number,
  opts: { status?: number; failCount?: number } = {},
): Promise<number> {
  const [row] = await db
    .insert(channels)
    .values({
      providerId,
      name: uid('ch'),
      apiKeyEnc: 'enc:v1:00:00:00',
      ...(opts.status !== undefined ? { status: opts.status } : {}),
      ...(opts.failCount !== undefined ? { failCount: opts.failCount } : {}),
    })
    .returning({ id: channels.id });
  createdChannels.push(row!.id);
  return row!.id;
}

export async function newMappingRow(opts: { externalName?: string; realModel?: string } = {}): Promise<number> {
  const [row] = await db
    .insert(modelMappings)
    .values({
      externalName: opts.externalName ?? uid('model'),
      realModel: opts.realModel ?? uid('real'),
    })
    .returning({ id: modelMappings.id });
  createdMappings.push(row!.id);
  return row!.id;
}

export const trackMapping = (id: number): void => {
  createdMappings.push(id);
};
export const trackChannel = (id: number): void => {
  createdChannels.push(id);
};
export const trackProvider = (id: number): void => {
  createdProviders.push(id);
};
export const trackCard = (id: number): void => {
  createdCards.push(id);
};

export async function newUserBoundToCard(rateCardId: number): Promise<number> {
  const [row] = await db
    .insert(users)
    .values({
      issuer: 'local',
      subject: uid('user'),
      identityProvider: 'local',
      rateCardId,
    })
    .returning({ id: users.id });
  createdUsers.push(row!.id);
  return row!.id;
}

/** 普通用户（可指定 issuer——非本地账号守卫测试用） */
export async function newUserRow(opts: { issuer?: string; displayName?: string | null } = {}): Promise<number> {
  const [row] = await db
    .insert(users)
    .values({
      issuer: opts.issuer ?? 'local',
      subject: uid('user'),
      identityProvider: opts.issuer ?? 'local',
      ...(opts.displayName !== undefined ? { displayName: opts.displayName } : {}),
    })
    .returning({ id: users.id });
  createdUsers.push(row!.id);
  return row!.id;
}

/** 套餐行（periodDays 校验语义走服务路径，测试造数直插） */
export async function newPlanRow(opts: {
  price?: string;
  quotaAmount?: string;
  periodDays?: number;
  kind?: 'subscription' | 'pack';
  allowSeats?: boolean;
} = {}): Promise<number> {
  const [row] = await db
    .insert(plans)
    .values({
      name: uid('plan'),
      kind: opts.kind ?? 'subscription',
      price: opts.price ?? '30',
      periodDays: opts.periodDays ?? 30,
      quotaAmount: opts.quotaAmount ?? '30',
      allowSeats: opts.allowSeats ?? false,
    })
    .returning({ id: plans.id });
  createdPlans.push(row!.id);
  return row!.id;
}

export const trackPlan = (id: number): void => {
  createdPlans.push(id);
};

/** 用户 API Key（管理面 Key 列表/补丁测试夹具；keyHash 即哈希无明文） */
export async function newUserKeyRow(userId: number, opts: { name?: string } = {}): Promise<number> {
  const [row] = await db
    .insert(apiKeys)
    .values({
      keyHash: randomUUID().replace(/-/g, ''),
      keyPreview: 'ag_****test',
      userId,
      name: opts.name ?? uid('key'),
    })
    .returning({ id: apiKeys.id });
  createdApiKeys.push(row!.id);
  return row!.id;
}

export const trackApiKey = (id: number): void => {
  createdApiKeys.push(id);
};

export const trackBatch = (id: number): void => {
  createdBatches.push(id);
};

export const trackUser = (id: number): void => {
  createdUsers.push(id);
};

/** 资金入账（wallet.credit refType=admin——与生产调账同动词） */
export async function fundUser(userId: number, amount: string): Promise<void> {
  await wallet.credit(
    { requestId: `test-fund-${randomUUID()}`, actor: { kind: 'system' }, traceParent: null },
    { userId, amount, refType: 'admin', refId: `test-fund:${randomUUID()}` },
  );
}

/** 桩 Ai（探针测试：记录调用形状，回放预设结果） */
export function stubAi(
  onCall?: (input: unknown) => void,
  result:
    | { status: 'success'; usage?: { inputTokens: number; outputTokens: number } }
    | { status: 'error'; code: string } = { status: 'success', usage: { inputTokens: 2, outputTokens: 1 } },
): () => Ai {
  return () =>
    ({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      async chat(input: any) {
        onCall?.(input);
        if (result.status === 'success') {
          return { status: 'success', usage: result.usage, durationMs: 1 };
        }
        return {
          status: 'error',
          error: Object.assign(new Error('stub upstream error'), {
            code: result.code,
            retryable: true,
            circuitTrip: false,
            deadCredential: false,
          }),
          durationMs: 1,
        };
      },
    }) as unknown as Ai;
}

afterAll(async () => {
  // 反向 FK（全 NO ACTION）：绑定 → 系数(引用映射) → 映射 → 渠道 → 供应商；
  // 用户先解绑卡引用；admins 删除时 audit_logs.admin_id 由 FK 置空。
  if (createdUsers.length) {
    // 用户删除前：订阅行、Key、兑换历史解绑、计量/请求日志清行（全 NO ACTION 反向序）
    await db.delete(usageLogs).where(inArray(usageLogs.userId, createdUsers));
    await db.delete(requestLogs).where(inArray(requestLogs.userId, createdUsers));
    await db.delete(userSubscriptions).where(inArray(userSubscriptions.userId, createdUsers));
    await db.delete(apiKeys).where(inArray(apiKeys.userId, createdUsers));
    await db.update(redeemCodes).set({ usedBy: null }).where(inArray(redeemCodes.usedBy, createdUsers));
    await db.update(users).set({ rateCardId: null }).where(inArray(users.id, createdUsers));
    await db.delete(users).where(inArray(users.id, createdUsers));
  }
  if (createdBatches.length) {
    await db.delete(redeemCodes).where(inArray(redeemCodes.batchId, createdBatches));
    await db.delete(redeemBatches).where(inArray(redeemBatches.id, createdBatches));
  }
  if (createdCards.length) {
    await db.delete(rateCardCoefficients).where(inArray(rateCardCoefficients.rateCardId, createdCards));
    await db.delete(rateCards).where(inArray(rateCards.id, createdCards));
  }
  if (createdMappings.length) {
    await db.delete(modelChannels).where(inArray(modelChannels.mappingId, createdMappings));
    await db.delete(rateCardCoefficients).where(inArray(rateCardCoefficients.modelMappingId, createdMappings));
    await db.delete(modelMappings).where(inArray(modelMappings.id, createdMappings));
  }
  if (createdChannels.length) {
    await db.delete(channelRecharges).where(inArray(channelRecharges.channelId, createdChannels));
    await db.delete(modelChannels).where(inArray(modelChannels.channelId, createdChannels));
    await db.delete(channels).where(inArray(channels.id, createdChannels));
  }
  // HTTP 路径建的供应商/渠道未走造数追踪——按测试名前缀兜底清扫
  const leftovers = await db
    .select({ id: providers.id })
    .from(providers)
    .where(ilike(providers.name, 'aav2-%'));
  for (const row of leftovers) {
    if (!createdProviders.includes(row.id)) createdProviders.push(row.id);
  }
  if (createdProviders.length) {
    // 服务路径建的渠道（未走造数追踪）按 provider 归属兜底清扫
    const refs = await db
      .select({ id: channels.id })
      .from(channels)
      .where(inArray(channels.providerId, createdProviders));
    if (refs.length) {
      const refIds = refs.map((r) => r.id);
      await db.delete(modelChannels).where(inArray(modelChannels.channelId, refIds));
      // 进货流水先于渠道删（FK；套件中断残留不再卡死整个清理链）
      await db.delete(channelRecharges).where(inArray(channelRecharges.channelId, refIds));
      await db.delete(channels).where(inArray(channels.id, refIds));
    }
    await db.delete(providers).where(inArray(providers.id, createdProviders));
  }
  if (createdPlans.length) await db.delete(plans).where(inArray(plans.id, createdPlans));
  if (createdApiKeys.length) await db.delete(apiKeys).where(inArray(apiKeys.id, createdApiKeys));
  if (createdAdmins.length) await db.delete(admins).where(inArray(admins.id, createdAdmins));
  await db.$client.end().catch(() => {});
});
