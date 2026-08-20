/**
 * 装配根：进程级依赖一次组装（db / Redis / 守卫 / 邮件 / 服务 / 探针）。
 * 全部可变值来自 config——本文件零字面量配置。
 *
 * REDIS_URL 未配置 = 单副本开发形态：登录爆破防护降级关闭、路由缓存失效
 * 靠网关 5 分钟 TTL 兜底；配置即生产形态。
 * 探针 SSRF 硬闸：allowLocalUpstream 生产恒关（配置开了也被拦——fail-closed）。
 */
import { createRedisSessionRevocationStore } from '@ai-gateway/identity';
import { createDb } from '@ai-gateway/db';
import type { Db } from '@ai-gateway/repository';
import type { Redis } from 'ioredis';
import {
  createAi,
  defaultAiConfig,
  MemoryKvStorage,
  type Ai,
} from '@ai-gateway/ai';
import {
  createAuthFailureGuard,
  createKeyBruteForceGuard,
  createRedisClient,
  initOtel,
} from '@ai-gateway/core';
import { mailerFromEnv, ADMIN_MAIL_BRAND, type Mailer } from '@ai-gateway/identity';
import {
  createSubscriptionDomain,
  createWallet,
  type SubscriptionDomain,
  type WalletApi,
} from '@ai-gateway/service';
import { createAdminAuthService } from './services/auth.service.js';
import { createProvidersService } from './services/providers.service.js';
import { createChannelsService } from './services/channels.service.js';
import { createModelsService } from './services/models.service.js';
import { createRateCardsService } from './services/rate-cards.service.js';
import {
  createCatalogService,
  MODELS_DEV_SOURCE,
  OPENROUTER_SOURCE,
  type CatalogSource,
} from './services/catalog.service.js';
import { createFxService } from './services/fx.service.js';
import { createFundsService } from './services/funds.service.js';
import { createUsersService } from './services/users.service.js';
import { createAdminKeysService } from './services/keys.service.js';
import { createAdminSubscriptionsService } from './services/subscriptions.service.js';
import { createPlansService } from './services/plans.service.js';
import { createRedeemService } from './services/redeem.service.js';
import { createChannelFundsService } from './services/channel-funds.service.js';
import { createLocalVoucherStorage, type VoucherStorage } from './services/voucher-storage.js';
import { createOpsLogsService } from './services/ops-logs.service.js';
import { createBillingReviewService } from './services/billing-review.service.js';
import { createTracingService } from './services/tracing.service.js';
import { createNotificationsService } from './services/notifications.service.js';
import type { AdminApiConfig } from './config.js';

export interface AdminApiAssembly {
  auth: ReturnType<typeof createAdminAuthService>;
  providers: ReturnType<typeof createProvidersService>;
  channels: ReturnType<typeof createChannelsService>;
  models: ReturnType<typeof createModelsService>;
  rateCards: ReturnType<typeof createRateCardsService>;
  catalog: ReturnType<typeof createCatalogService>;
  fx: ReturnType<typeof createFxService>;
  users: ReturnType<typeof createUsersService>;
  funds: ReturnType<typeof createFundsService>;
  adminKeys: ReturnType<typeof createAdminKeysService>;
  adminSubscriptions: ReturnType<typeof createAdminSubscriptionsService>;
  plans: ReturnType<typeof createPlansService>;
  redeem: ReturnType<typeof createRedeemService>;
  channelFunds: ReturnType<typeof createChannelFundsService>;
  voucherStorage: VoucherStorage;
  opsLogs: ReturnType<typeof createOpsLogsService>;
  billingReview: ReturnType<typeof createBillingReviewService>;
  tracing: ReturnType<typeof createTracingService>;
  notifications: ReturnType<typeof createNotificationsService>;
  subscriptions: SubscriptionDomain;
  wallet: WalletApi;
  mailer: Mailer | null;
  redis: Redis;
  /** 会话 jti 吊销表（logout 即时下线） */
  revocationStore: ReturnType<typeof createRedisSessionRevocationStore>;
  otel: { shutdown(): Promise<void> };
}

export function assembleAdminApi(
  config: AdminApiConfig,
  db: Db = createDb(config.DATABASE_URL, { poolMax: config.DB_POOL_MAX }),
): AdminApiAssembly {
  // Redis 必配（首选组件：登录爆破防护/渠道缓存失效广播；启动入口已做连通性验证）
  const redis = createRedisClient(config.REDIS_URL, { serviceName: 'admin-api' });
  const loginGuard = createKeyBruteForceGuard(redis, {
    failureThreshold: config.LOGIN_FAILURE_THRESHOLD,
    failureWindowS: config.LOGIN_FAILURE_WINDOW_S,
    lockS: config.LOGIN_LOCK_S,
  });
  const ipGuard = createAuthFailureGuard(redis, {
    limit: config.LOGIN_IP_FAILURE_LIMIT,
    windowS: config.LOGIN_IP_FAILURE_WINDOW_S,
  });

  const mailer = mailerFromEnv(config, ADMIN_MAIL_BRAND);

  // 探针 Ai 工厂：独立诊断面——每次全新内存态（熔断/死凭据不跨探针、不污染网关）；
  // 本地上游放行 = 配置开关 && 非生产（生产误配也被硬拦）
  const allowLocalUpstream = config.ALLOW_LOCAL_UPSTREAM && process.env.NODE_ENV !== 'production';
  const createTester = (): Ai =>
    createAi(
      { ...defaultAiConfig(), allowLocalUrl: allowLocalUpstream },
      {
        breakerStorage: new MemoryKvStorage(),
        deadCredentialStorage: new MemoryKvStorage(),
      },
    );

  const auth = createAdminAuthService({
    db,
    jwtSecret: config.ADMIN_JWT_SECRET,
    sessionTtlSeconds: config.SESSION_TTL_SECONDS,
    loginGuard,
    ipGuard,
    mailer,
  });
  const providers = createProvidersService({ db, redis });
  const channels = createChannelsService({
    db,
    redis,
    encryptionKey: config.ENCRYPTION_KEY,
    importMax: config.CHANNEL_IMPORT_MAX,
    createTester,
  });
  const models = createModelsService({
    db,
    redis,
    encryptionKey: config.ENCRYPTION_KEY,
    createTester,
  });
  const rateCards = createRateCardsService({ db });
  const fx = createFxService({ db });
  const catalog = createCatalogService({
    db,
    redis,
    sources: [OPENROUTER_SOURCE, MODELS_DEV_SOURCE] satisfies readonly CatalogSource[],
    cacheTtlMs: config.CATALOG_CACHE_TTL_MS,
    freeChannelRpm: config.CATALOG_FREE_CHANNEL_RPM,
    freeChannelBudget: config.CATALOG_FREE_CHANNEL_BUDGET,
    encryptionKey: config.ENCRYPTION_KEY,
    fx,
  });

  // 资金面：管理面经手三类业务域（admin 调账/赠送、订阅收款、加油包发放）
  const wallet = createWallet({
    db,
    guards: {
      refTypes: ['admin', 'subscription', 'pack'],
      currencies: [config.ADMIN_CURRENCY],
      internalAccounts: ['outside', 'platform_revenue'],
    },
    currency: config.ADMIN_CURRENCY,
  });
  const subscriptions = createSubscriptionDomain({ db, wallet });
  const funds = createFundsService({ db, wallet });
  const users = createUsersService({ db, wallet, redis });
  const adminKeys = createAdminKeysService({ db, redis });
  const adminSubscriptions = createAdminSubscriptionsService({ db, domain: subscriptions });
  const plans = createPlansService({ db });
  const redeem = createRedeemService({ db });
  const voucherStorage = createLocalVoucherStorage(config.VOUCHER_DIR);
  const channelFunds = createChannelFundsService({
    db,
    voucherStorage,
    voucherMaxBytes: config.VOUCHER_MAX_BYTES,
  });
  const opsLogs = createOpsLogsService({ db });
  const billingReview = createBillingReviewService({ db, wallet });
  const tracing = createTracingService({ db });
  const notifications = createNotificationsService({ db, encryptionKey: config.ENCRYPTION_KEY });

  const otel = initOtel({
    mode: config.OTEL_TRACES_MODE,
    endpoint: config.OTEL_EXPORTER_OTLP_ENDPOINT,
    serviceName: 'admin-api',
  });

  const revocationStore = createRedisSessionRevocationStore(redis, {
    logger: { warn: (obj: unknown, msg: string) => console.warn('[admin-api]', msg, obj) },
  });

  return {
    revocationStore,
    auth,
    providers,
    channels,
    models,
    rateCards,
    catalog,
    fx,
    users,
    funds,
    adminKeys,
    adminSubscriptions,
    plans,
    redeem,
    channelFunds,
    voucherStorage,
    opsLogs,
    billingReview,
    tracing,
    notifications,
    subscriptions,
    wallet,
    mailer,
    redis,
    otel,
  };
}
