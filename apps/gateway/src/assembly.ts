/**
 * 装配根：进程级依赖一次组装（db / Redis / 资金域 / 准入 / 限流 / 爆破防护 / OTel），
 * 请求级上下文由中间件派生。全部可变值来自 config——本文件零字面量配置。
 *
 * REDIS_URL 未配置 = 单副本开发形态：ai 状态进程内存、限流/爆破防护跳过；
 * 配置即生产形态：多副本共享熔断/死凭据状态、滑动窗口限流、两层鉴权爆破防护。
 */
import type { Redis } from 'ioredis';
import { createAi, type BreakerState, type DeadCredentialState } from '@ai-gateway/ai';
import { createDb } from '@ai-gateway/db';
import { createBillingDomain, createBacklogAdmission } from '@ai-gateway/service';
import type { BillingDomain } from '@ai-gateway/service';
import {
  AI_STORAGE_PREFIXES,
  createAuthFailureGuard,
  createKeyBruteForceGuard,
  createRedisClient,
  createRedisStateStorage,
  createSlidingWindowLimiter,
  initOtel,
} from '@ai-gateway/core';
import { createBuildQuote } from './quote/build-quote.js';
import { createResolveChannels } from './routing/resolve-channels.js';
import { createRunChat } from './pipeline/run-chat.js';
import { wireContextOverflowAlert } from './ai/overflow-alert.js';
import { createUpstreamAdapter } from './pipeline/upstream-adapter.js';
import { createTaskAdapter } from './generation/task-adapter.js';
import { createSubmitGeneration } from './generation/submit.js';
import { createFreeDailyGate, type RateLimitGate } from './rate-limit/gate.js';
import { createSettleWakeupProducer } from './billing/wakeup.js';
import type { AuthGuards } from './middleware/api-key.js';
import type { GatewayConfig } from './config.js';

export interface GatewayAssembly {
  db: ReturnType<typeof createDb>;
  billing: BillingDomain;
  runChat: ReturnType<typeof createRunChat>;
  submitGeneration: ReturnType<typeof createSubmitGeneration>;
  oauth: { jwtSecret: string; tokenTtlSeconds: number };
  /** 装配产物（Redis 必配形态） */
  redis: Redis;
  rateLimit: RateLimitGate;
  authGuards: AuthGuards;
  otel: { shutdown(): Promise<void> };
  settleWakeup: ReturnType<typeof createSettleWakeupProducer>;
}

export function assembleGateway(config: GatewayConfig): GatewayAssembly {
  const db = createDb(config.DATABASE_URL, { poolMax: config.DB_POOL_MAX });
  // Redis 必配（首选组件：限流/爆破防护/熔断状态共享；启动入口已做连通性验证）
  const redis = createRedisClient(config.REDIS_URL, { serviceName: 'gateway' });

  const admission = createBacklogAdmission({
    db,
    maxPending: config.ADMISSION_MAX_PENDING,
    maxOldestPendingMs: config.ADMISSION_MAX_OLDEST_MS,
  });
  // 结算唤醒生产端（BullMQ 门铃：signal → settlement_pending 即投递；入队失败兜底扫描覆盖）
  const settleWakeup = createSettleWakeupProducer(config.REDIS_URL, {
    logger: console as unknown as { warn(obj: unknown, msg: string): void },
  });
  const billing = createBillingDomain({
    db,
    currency: config.GATEWAY_CURRENCY,
    admission: { assertCapacity: admission },
    wake: settleWakeup.wake,
  });

  // ai 状态存储：Redis 多副本共享（熔断/死凭据全副本一致）
  const storages = {
    breakerStorage: createRedisStateStorage<BreakerState>(redis, AI_STORAGE_PREFIXES.breaker),
    deadCredentialStorage: createRedisStateStorage<DeadCredentialState>(redis, AI_STORAGE_PREFIXES.credential),
  };
  const ai = createAi(
    {
      timeout: { connectMs: config.GATEWAY_UPSTREAM_CONNECT_TIMEOUT_MS },
      // SSRF 双门（与 admin-api 同口径）：逃生门仅非生产可用——生产误配 env 也恒关
      ...(config.GATEWAY_AI_ALLOW_LOCAL_URL && process.env.NODE_ENV !== 'production' ? { allowLocalUrl: true } : {}),
    },
    { ...storages },
  );

  // 静默溢出告警（P1#4）：success 事件旗标 → notify_outbox（worker 按渠道订阅投递）
  wireContextOverflowAlert(ai, db);

  // 限流闸与鉴权爆破防护（Redis 必配形态；fail-closed 语义在 core 模块默认）
  const limiter = createSlidingWindowLimiter(redis);
  const rateLimit: RateLimitGate = {
    limiter,
    freeDaily: createFreeDailyGate(redis, config.FREE_MODEL_DAILY_LIMIT),
    globalRpm: config.GLOBAL_RPM,
  };
  const authGuards: AuthGuards = {
    keyGuard: createKeyBruteForceGuard(redis, {
      failureThreshold: config.AUTH_KEY_FAILURE_THRESHOLD,
      failureWindowS: config.AUTH_KEY_FAILURE_WINDOW_S,
      lockS: config.AUTH_KEY_LOCK_S,
    }),
    ipGuard: createAuthFailureGuard(redis, {
      limit: config.AUTH_IP_FAILURE_LIMIT,
      windowS: config.AUTH_IP_FAILURE_WINDOW_S,
    }),
    // 用户级限流兜底（凭证/Scope 未声明时生效——v1 DEFAULT_USER_RPM 对位）
    defaultUserRpm: config.DEFAULT_USER_RPM,
    defaultUserTpm: config.DEFAULT_USER_TPM,
    trustedProxyHops: config.TRUSTED_PROXY_HOPS,
  };

  const buildQuote = createBuildQuote({ db });
  const resolveChannels = createResolveChannels({ db });
  const encryption = { encryptionKey: config.CHANNEL_API_KEY_ENCRYPTION };
  const runChat = createRunChat({
    db,
    billing,
    buildQuote,
    resolveChannels,
    upstream: createUpstreamAdapter({ ai, ...encryption, deadlineMs: config.GATEWAY_UPSTREAM_DEADLINE_MS }),
    ...(rateLimit ? { rateLimit } : {}),
    config: {
      reservationLimit: config.BILLING_RESERVATION_MAX,
      authorizationTtlMs: config.BILLING_AUTHORIZATION_TTL_MS,
      output: {
        defaultMax: config.DEFAULT_MAX_OUTPUT_TOKENS,
        exposureCap: config.GATEWAY_OUTPUT_EXPOSURE_CAP,
      },
    },
  });
  const submitGeneration = createSubmitGeneration({
    db,
    billing,
    buildQuote,
    resolveChannels,
    taskPort: createTaskAdapter({ ai, ...encryption }),
    ...(rateLimit ? { rateLimit } : {}),
    config: {
      taskTtlMs: config.GENERATION_TASK_TTL_MS,
      leaseGraceMs: config.GENERATION_LEASE_GRACE_MS,
      reservationLimit: config.BILLING_RESERVATION_MAX,
      maxActivePerUser: config.GENERATION_MAX_ACTIVE_PER_USER,
    },
  });

  const otel = initOtel({
    serviceName: 'gateway',
    mode: config.OTEL_TRACES_MODE,
    endpoint: config.OTEL_EXPORTER_OTLP_ENDPOINT,
  });

  return {
    db,
    billing,
    runChat,
    submitGeneration,
    oauth: { jwtSecret: config.JWT_SECRET, tokenTtlSeconds: config.JWT_TOKEN_TTL_SECONDS },
    redis,
    rateLimit,
    authGuards,
    otel,
    settleWakeup,
  };
}
