/**
 * 模型映射路由（会话）：列表（channelIds 回显）/ 创建 / 更新 / 软下架 /
 * 绑定全量替换 / 逐渠道探针。
 * 数值域铁三角（v1 red test 语义原样）：z.coerce + .finite() + MONEY_MAX——
 * '1e999'(Infinity) / 1e21 / contextLength 1e30 一律 400，绝不溢出到 PG 500。
 */
import { Hono } from 'hono';
import type { MiddlewareHandler } from 'hono';
import { z } from 'zod';
import { adminCtxOf } from './ctx.js';
import { parseListQuery } from '../http/list-query.js';
import { AppError } from '../http/error-map.js';
import { MODEL_SORTS, type ModelsService } from '../services/models.service.js';
import type { SessionEnv } from '../middleware/session.js';

const MONEY_MAX = 1e9;
const CONTEXT_LENGTH_MAX = 2_000_000_000;

const price = z.coerce.number().min(0).finite().max(MONEY_MAX);


/** 多模态统一输入计费策略（v1 对位：billingConfig 消费方在网关 build-quote/receipt） */
const billingPolicySchema = z.object({
  version: z.literal(1),
  billingMode: z.literal('unified_input_tokens'),
  maxInputTokens: z.number().int().positive(),
  modalities: z
    .object({
      image: z.object({ maxItems: z.number().int().positive(), maxInlineBytes: z.number().int().positive().optional() }).optional(),
      audio: z.object({ maxItems: z.number().int().positive(), maxInlineBytes: z.number().int().positive().optional() }).optional(),
      file: z.object({ maxItems: z.number().int().positive(), maxInlineBytes: z.number().int().positive().optional() }).optional(),
    })
    .strict(),
});
const createSchema = z.object({
  externalName: z.string().min(1).max(64),
  realModel: z.string().min(1).max(128),
  contextLength: z.coerce.number().int().positive().finite().max(CONTEXT_LENGTH_MAX).nullable().optional(),
  inputPrice: price,
  outputPrice: price,
  cacheInputPrice: price,
  /** 缓存写单价（元/百万 token；缺省 0 = 不收缓存写费） */
  cacheWritePrice: price.optional(),
  isFree: z.boolean().optional(),
  billingPolicy: billingPolicySchema.nullable().optional(),
  rpmLimit: z.coerce.number().int().positive().max(1e9).nullable().optional(),
  tpmLimit: z.coerce.number().int().positive().max(1e9).nullable().optional(),
});

const updateSchema = z.object({
  externalName: z.string().min(1).max(64).optional(),
  realModel: z.string().min(1).max(128).optional(),
  contextLength: z.coerce.number().int().positive().finite().max(CONTEXT_LENGTH_MAX).nullable().optional(),
  status: z.number().int().min(0).max(1).optional(),
  inputPrice: price.optional(),
  outputPrice: price.optional(),
  cacheInputPrice: price.optional(),
  cacheWritePrice: price.optional(),
  isFree: z.boolean().optional(),
  billingPolicy: billingPolicySchema.nullable().optional(),
  rpmLimit: z.coerce.number().int().positive().nullable().optional(),
  tpmLimit: z.coerce.number().int().positive().nullable().optional(),
});

const bindSchema = z.object({
  // 数组上限（防超长数组在单事务里 delete+bulk-insert 长时间压住 model_mappings 行锁）
  channels: z
    .array(
      z.object({
        channelId: z.number().int().positive(),
        weight: z.number().optional(),
        priority: z.number().optional(),
      }),
    )
    .max(500), // 空数组 = 解绑全部（既有语义）；上限防超长数组压行锁
});

const idParam = (raw: string): number => {
  const id = Number(raw);
  if (!Number.isInteger(id) || id < 1) {
    throw new AppError(400, 'invalid_param', '路径参数 id 必须为正整数');
  }
  return id;
};


export function modelsRoutes(service: ModelsService, session: MiddlewareHandler<SessionEnv>) {
  const app = new Hono<SessionEnv>();

  app.get('/v1/models', session, async (c) => {
    const query = parseListQuery(c.req.query(), MODEL_SORTS, 'createdAt');
    return c.json(await service.list(adminCtxOf(c), query));
  });

  app.post('/v1/models', session, async (c) => {
    const body = createSchema.parse(await c.req.json());
    const row = await service.create(adminCtxOf(c), {
      adminId: c.get('adminId'),
      externalName: body.externalName,
      realModel: body.realModel,
      contextLength: body.contextLength ?? null,
      prices: {
        inputPrice: String(body.inputPrice),
        outputPrice: String(body.outputPrice),
        cacheInputPrice: String(body.cacheInputPrice),
        cacheWritePrice: String(body.cacheWritePrice ?? 0),
      },
      isFree: body.isFree,
      rpmLimit: body.rpmLimit ?? null,
      tpmLimit: body.tpmLimit ?? null,
      billingPolicy: body.billingPolicy ?? null,
    });
    return c.json(row, 201);
  });

  app.patch('/v1/models/:id', session, async (c) => {
    const id = idParam(c.req.param('id'));
    const body = updateSchema.parse(await c.req.json());
    const row = await service.update(adminCtxOf(c), {
      adminId: c.get('adminId'),
      mappingId: id,
      patch: {
        ...(body.externalName !== undefined ? { externalName: body.externalName } : {}),
        ...(body.realModel !== undefined ? { realModel: body.realModel } : {}),
        ...(body.contextLength !== undefined ? { contextLength: body.contextLength } : {}),
        ...(body.status !== undefined ? { status: body.status } : {}),
        ...(body.isFree !== undefined ? { isFree: body.isFree } : {}),
        ...(body.billingPolicy !== undefined ? { billingPolicy: body.billingPolicy } : {}),
        ...(body.rpmLimit !== undefined ? { rpmLimit: body.rpmLimit } : {}),
        ...(body.tpmLimit !== undefined ? { tpmLimit: body.tpmLimit } : {}),
        ...(body.inputPrice !== undefined || body.outputPrice !== undefined || body.cacheInputPrice !== undefined || body.cacheWritePrice !== undefined
          ? {
              prices: {
                ...(body.inputPrice !== undefined ? { inputPrice: String(body.inputPrice) } : {}),
                ...(body.outputPrice !== undefined ? { outputPrice: String(body.outputPrice) } : {}),
                ...(body.cacheInputPrice !== undefined ? { cacheInputPrice: String(body.cacheInputPrice) } : {}),
                ...(body.cacheWritePrice !== undefined ? { cacheWritePrice: String(body.cacheWritePrice) } : {}),
              },
            }
          : {}),
      },
    });
    return c.json(row);
  });

  app.delete('/v1/models/:id', session, async (c) => {
    const id = idParam(c.req.param('id'));
    return c.json(await service.retire(adminCtxOf(c), { adminId: c.get('adminId'), mappingId: id }));
  });

  app.post('/v1/models/:id/channels', session, async (c) => {
    const id = idParam(c.req.param('id'));
    const body = bindSchema.parse(await c.req.json());
    const result = await service.bindChannels(adminCtxOf(c), {
      adminId: c.get('adminId'),
      mappingId: id,
      channels: body.channels,
    });
    return c.json({ ok: true, bound: result.bound });
  });

  app.post('/v1/models/:id/test', session, async (c) => {
    const id = idParam(c.req.param('id'));
    return c.json(await service.probe(adminCtxOf(c), id));
  });


  return app;
}
