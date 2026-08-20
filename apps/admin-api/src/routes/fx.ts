/**
 * 目录汇率路由（会话）：状态（含懒拉）/ 强制刷新 / 手动覆盖与清除 / 点差。
 * 全部动作留审计（fx.override / fx.override_clear / fx.buffer）。
 */
import { Hono } from 'hono';
import type { MiddlewareHandler } from 'hono';
import { z } from 'zod';
import { adminCtxOf } from './ctx.js';
import type { FxService } from '../services/fx.service.js';
import type { SessionEnv } from '../middleware/session.js';

const overrideSchema = z.object({ rate: z.coerce.string().min(1).max(16) });
const bufferSchema = z.object({ bufferPct: z.coerce.string().min(1).max(8) });
const refreshSchema = z.object({ force: z.boolean().optional() });

export function fxCatalogRoutes(service: FxService, session: MiddlewareHandler<SessionEnv>) {
  const app = new Hono<SessionEnv>();

  app.get('/v1/fx/catalog', session, async (c) =>
    c.json(await service.state(adminCtxOf(c))),
  );

  app.post('/v1/fx/catalog/refresh', session, async (c) => {
    const body = refreshSchema.parse(await c.req.json().catch(() => ({})));
    return c.json(
      await service.refresh(adminCtxOf(c), {
        adminId: c.get('adminId'),
        force: body.force === true,
      }),
    );
  });

  app.put('/v1/fx/catalog/override', session, async (c) => {
    const body = overrideSchema.parse(await c.req.json());
    return c.json(
      await service.setOverride(adminCtxOf(c), { adminId: c.get('adminId'), rate: body.rate }),
    );
  });

  app.delete('/v1/fx/catalog/override', session, async (c) =>
    c.json(await service.clearOverride(adminCtxOf(c), { adminId: c.get('adminId') })),
  );

  app.put('/v1/fx/catalog/buffer', session, async (c) => {
    const body = bufferSchema.parse(await c.req.json());
    return c.json(
      await service.setBuffer(adminCtxOf(c), {
        adminId: c.get('adminId'),
        bufferPct: body.bufferPct,
      }),
    );
  });

  return app;
}
