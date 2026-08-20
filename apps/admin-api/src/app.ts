/**
 * HTTP app（协议适配层）：错误信封收口 + 请求链 + 路由挂载。
 * 业务一律来自本 app services——本层零业务规则（错误映射表与会话校验链是
 * 协议契约，不是规则）。
 */
import { Hono } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { ZodError } from 'zod';
import type { Db } from '@ai-gateway/repository';
import { createRepositories } from '@ai-gateway/repository';
import { AppError, mapErrorToHttp } from './http/error-map.js';
import { sessionMiddleware, type SessionEnv } from './middleware/session.js';
import {
  requestIdMiddleware,
  corsPreflight,
  securityHeaders,
  bodyParserLimit,
} from './middleware/protocol.js';
import { authRoutes } from './routes/auth.js';
import { meRoutes } from './routes/me.js';
import { providersRoutes } from './routes/providers.js';
import { channelsRoutes } from './routes/channels.js';
import { modelsRoutes } from './routes/models.js';
import { rateCardsRoutes } from './routes/rate-cards.js';
import { catalogRoutes } from './routes/catalog.js';
import { fxCatalogRoutes } from './routes/fx.js';
import { usersRoutes } from './routes/users.js';
import { adminKeysRoutes } from './routes/keys.js';
import { adminSubscriptionsRoutes } from './routes/subscriptions.js';
import { plansRoutes } from './routes/plans.js';
import { redeemRoutes } from './routes/redeem.js';
import { channelFundsRoutes } from './routes/channel-funds.js';
import { vouchersRoutes } from './routes/vouchers.js';
import { opsRoutes } from './routes/ops.js';
import { billingOperationsRoutes } from './routes/billing-operations.js';
import { tracingRoutes } from './routes/tracing.js';
import { notificationsRoutes } from './routes/notifications.js';
import type { AdminApiAssembly } from './assembly.js';

export interface AppDeps {
  db: Db;
  assembly: AdminApiAssembly;
  jwtSecret: string;
  corsOrigins: readonly string[];
  bodyLimitBytes: number;
  trustedProxyHops: number;
}

export function createApp(deps: AppDeps) {
  const { db } = deps;
  const app = new Hono<SessionEnv>();
  const repos = createRepositories();
  const session = sessionMiddleware(db, deps.jwtSecret, deps.assembly.revocationStore);

  app.onError((error, c) => {
    if (error instanceof ZodError) {
      return c.json({ error: { code: 'invalid_request', message: '请求参数不合法' } }, 400);
    }
    const mapped = mapErrorToHttp(error);
    if (mapped.status >= 500) console.error('[admin-api] internal error:', error);
    if (error instanceof AppError && error.headers) {
      for (const [key, value] of Object.entries(error.headers)) c.header(key, value);
    }
    return c.json(
      { error: { code: mapped.code, message: mapped.message } },
      mapped.status as ContentfulStatusCode,
    );
  });

  app.notFound((c) => c.json({ error: { code: 'not_found', message: '路径不存在' } }, 404));

  app.use('*', corsPreflight(deps.corsOrigins));
  app.use('*', securityHeaders);
  app.use('*', bodyParserLimit(deps.bodyLimitBytes));
  app.use('*', requestIdMiddleware());

  app.get('/healthz', async (c) => {
    await repos.health.ping({
      db,
      requestId: c.get('requestId'),
      actor: { kind: 'system' },
      traceParent: null,
    });
    // Redis readiness（首选组件：不可达 = 不健康——LB/编排器应摘除本副本）
    try {
      await deps.assembly.redis.ping();
    } catch {
      return c.json({ ok: false, redis: 'down' }, 503);
    }
    return c.json({ ok: true });
  });

  app.route(
    '/',
    authRoutes(deps.assembly.auth, {
      trustedProxyHops: deps.trustedProxyHops,
      session,
      revocationStore: deps.assembly.revocationStore,
    }),
  );
  app.route('/', meRoutes(deps.assembly.auth, session));
  app.route('/', providersRoutes(deps.assembly.providers, session));
  app.route('/', channelsRoutes(deps.assembly.channels, session));
  app.route('/', modelsRoutes(deps.assembly.models, session));
  app.route('/', rateCardsRoutes(deps.assembly.rateCards, session));
  app.route('/', catalogRoutes(deps.assembly.catalog, session));
  app.route('/', fxCatalogRoutes(deps.assembly.fx, session));
  app.route('/', usersRoutes(deps.assembly.users, deps.assembly.funds, session));
  app.route('/', adminKeysRoutes(deps.assembly.adminKeys, session));
  app.route('/', adminSubscriptionsRoutes(deps.assembly.adminSubscriptions, session));
  app.route('/', plansRoutes(deps.assembly.plans, session));
  app.route('/', redeemRoutes(deps.assembly.redeem, session));
  app.route('/', channelFundsRoutes(deps.assembly.channelFunds, session));
  app.route('/', vouchersRoutes(deps.assembly.voucherStorage, session));
  app.route('/', opsRoutes(deps.assembly.opsLogs, session));
  app.route('/', billingOperationsRoutes(deps.assembly.billingReview, session));
  app.route('/', tracingRoutes(deps.assembly.tracing, session));
  app.route('/', notificationsRoutes(deps.assembly.notifications, session));

  return app;
}
