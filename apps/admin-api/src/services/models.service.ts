/**
 * 模型映射管理服务：CRUD + 绑定全量替换 + 绑定渠道探针。
 *
 * 资金相关不变量：
 *   - R6：isFree=true 必须全零价（创建直判；更新按「旧值 ∪ 新值」合并判——
 *     部分补丁不能造出矛盾态，如 isFree=true + 只改 outputPrice>0）
 *   - 价格变更走审计（影响计费的历史可解释性）
 * 绑定语义：POST /:id/channels = 全量替换（删旧插新，单事务）；
 * 空数组 = 解绑全部。探针 = 逐渠道最小成本生成（"1" + max_tokens 1）。
 */
import type { Ai } from '@ai-gateway/ai';
import { decrypt } from '@ai-gateway/core';
import type { Redis } from 'ioredis';
import { recordAudit } from '@ai-gateway/http';
import type { Db } from '@ai-gateway/repository';
import {
  createRepositories,
  type Repositories,
  type MappingAdminRow,
} from '@ai-gateway/repository';
import type { RunContext } from '@ai-gateway/service';
import { AppError } from '../http/error-map.js';
import { freePriceConsistent } from '../domain/model-pricing.js';
import type { ListQueryParts } from '../http/list-query.js';

export const MODEL_SORTS = ['id', 'externalName', 'realModel', 'status', 'createdAt'] as const;

export interface ModelsServiceDeps {
  db: Db;
  repos?: Repositories;
  redis: Redis | null;
  /** 渠道密钥解密密钥（单 key 单格式 enc:v1） */
  encryptionKey: string;
  /** 探针 Ai 工厂：每次探针新建（内存态熔断/死凭据不跨探针共享、不污染网关） */
  createTester: () => Ai;
}

export interface ModelPricesInput {
  inputPrice: string;
  outputPrice: string;
  cacheInputPrice: string;
  cacheWritePrice: string;
}

export interface ModelsService {
  list(
    ctx: RunContext,
    query: ListQueryParts,
  ): Promise<{ rows: Array<MappingAdminRow & { channelIds: number[] }>; total: number; page: number; pageSize: number }>;
  create(
    ctx: RunContext,
    input: {
      adminId: number;
      externalName: string;
      realModel: string;
      contextLength?: number | null;
      prices: ModelPricesInput;
      isFree?: boolean;
      billingPolicy?: Record<string, unknown> | null;
      rpmLimit?: number | null;
      tpmLimit?: number | null;
    },
  ): Promise<MappingAdminRow>;
  update(
    ctx: RunContext,
    input: {
      adminId: number;
      mappingId: number;
      patch: {
        externalName?: string;
        realModel?: string;
        contextLength?: number | null;
        status?: number;
        prices?: Partial<ModelPricesInput>;
        isFree?: boolean;
        billingPolicy?: Record<string, unknown> | null;
        rpmLimit?: number | null;
        tpmLimit?: number | null;
      };
    },
  ): Promise<MappingAdminRow>;
  retire(ctx: RunContext, input: { adminId: number; mappingId: number }): Promise<{ ok: true }>;
  /** 绑定全量替换（事务内删旧插新）；返回新绑定数 */
  bindChannels(
    ctx: RunContext,
    input: { adminId: number; mappingId: number; channels: Array<{ channelId: number; weight?: number; priority?: number }> },
  ): Promise<{ bound: number }>;
  /** 逐渠道最小成本探针：真实解密密钥 + "1"/max_tokens=1 请求 */
  probe(ctx: RunContext, mappingId: number): Promise<{
    results: Array<{
      channelId: number;
      channel: string;
      ok: boolean;
      durationMs: number;
      tokens?: number;
      error?: { code: string; message: string };
    }>;
  }>;
}

/** R6 校验：isFree=true 必须全零价（矛盾态在服务边界拒绝） */
function assertFreeConsistency(isFree: boolean, prices: ModelPricesInput): void {
  if (!freePriceConsistent(isFree, prices)) {
    throw new AppError(400, 'free_model_price_conflict', '显式免费模型必须全零价（input/output/cache 三价均为 0）');
  }
}

export function createModelsService(deps: ModelsServiceDeps): ModelsService {
  const { db } = deps;
  const repos = deps.repos ?? createRepositories();


  return {
    async list(ctx, query) {
      const result = await repos.modelMapping.listMappings({ db, ...ctx }, {
        q: query.q,
        sortBy: query.sortBy as (typeof MODEL_SORTS)[number],
        order: query.order,
        limit: query.limit,
        offset: query.offset,
      });
      // channelIds 回显：仅当前页映射一次批量查（未绑定 = []，前端绑定弹窗回显）
      const bindings = await repos.modelMapping.listChannelIdsByMappingIds(
        { db, ...ctx },
        result.rows.map((row) => row.id),
      );
      const byMapping = new Map<number, number[]>();
      for (const b of bindings) {
        const list = byMapping.get(b.mappingId) ?? [];
        list.push(b.channelId);
        byMapping.set(b.mappingId, list);
      }
      return {
        rows: result.rows.map((row) => ({ ...row, channelIds: byMapping.get(row.id) ?? [] })),
        total: result.total,
        page: query.page,
        pageSize: query.pageSize,
      };
    },

    async create(ctx, input) {
      const isFree = input.isFree ?? false;
      assertFreeConsistency(isFree, input.prices);
      const row = await db.transaction(async (tx) =>
        repos.modelMapping.insertMapping({ db: tx, ...ctx }, {
          externalName: input.externalName,
          realModel: input.realModel,
          contextLength: input.contextLength ?? null,
          inputPrice: input.prices.inputPrice,
          outputPrice: input.prices.outputPrice,
          cacheInputPrice: input.prices.cacheInputPrice,
          cacheWritePrice: input.prices.cacheWritePrice ?? '0',
          isFree,
          billingPolicy: (input.billingPolicy ?? null) as Record<string, unknown> | null,
          rpmLimit: input.rpmLimit ?? null,
          tpmLimit: input.tpmLimit ?? null,
        }),
      );
      await recordAudit(db, {
        actor: 'admin',
        adminId: input.adminId,
        action: 'model.create',
        targetType: 'model_mapping',
        targetId: row.id,
        detail: { externalName: row.externalName, realModel: row.realModel, prices: input.prices, isFree },
      });
      return row;
    },

    async update(ctx, input) {
      const existing = await repos.modelMapping.findById({ db, ...ctx }, input.mappingId);
      if (!existing) throw new AppError(404, 'model_not_found', '模型不存在');

      // 合并口径判相容（R6）：部分补丁不得造出「isFree=true + 非零价」矛盾态
      const mergedPrices = {
        inputPrice: input.patch.prices?.inputPrice ?? existing.inputPrice,
        outputPrice: input.patch.prices?.outputPrice ?? existing.outputPrice,
        cacheInputPrice: input.patch.prices?.cacheInputPrice ?? existing.cacheInputPrice,
        cacheWritePrice: input.patch.prices?.cacheWritePrice ?? existing.cacheWritePrice,
      };
      const mergedFree = input.patch.isFree ?? existing.isFree;
      assertFreeConsistency(mergedFree, mergedPrices);

      const { prices, ...rest } = input.patch;
      const row = await db.transaction(async (tx) =>
        repos.modelMapping.updateMapping({ db: tx, ...ctx }, {
          mappingId: input.mappingId,
          patch: { ...rest, ...prices },
        }),
      );
      if (!row) throw new AppError(404, 'model_not_found', '模型不存在');
      // 价格变更影响计费：全量补丁进审计（历史可解释）
      await recordAudit(db, {
        actor: 'admin',
        adminId: input.adminId,
        action: 'model.update',
        targetType: 'model_mapping',
        targetId: row.id,
        detail: { patch: { ...input.patch, prices: input.patch.prices } },
      });
      return row;
    },

    async retire(ctx, input) {
      const ok = await repos.modelMapping.retireMapping({ db, ...ctx }, { mappingId: input.mappingId });
      if (!ok) throw new AppError(404, 'model_not_found', '模型不存在');
      await recordAudit(db, {
        actor: 'admin',
        adminId: input.adminId,
        action: 'model.retire',
        targetType: 'model_mapping',
        targetId: input.mappingId,
      });
      return { ok: true as const };
    },

    async bindChannels(ctx, input) {
      const existing = await repos.modelMapping.findById({ db, ...ctx }, input.mappingId);
      if (!existing) throw new AppError(404, 'model_not_found', '模型不存在');
      const bound = await db.transaction(async (tx) =>
        repos.modelMapping.replaceModelChannels({ db: tx, ...ctx }, {
          mappingId: input.mappingId,
          channels: input.channels.map((ch) => ({
            channelId: ch.channelId,
            weight: ch.weight ?? 1,
            priority: ch.priority ?? 0,
          })),
        }),
      );
      await recordAudit(db, {
        actor: 'admin',
        adminId: input.adminId,
        action: 'model.bind_channels',
        targetType: 'model_mapping',
        targetId: input.mappingId,
        detail: { channelIds: input.channels.map((ch) => ch.channelId) },
      });
      return { bound };
    },

    async probe(ctx, mappingId) {
      const existing = await repos.modelMapping.findById({ db, ...ctx }, mappingId);
      if (!existing) throw new AppError(404, 'model_not_found', '模型不存在');
      const channels = await repos.modelMapping.listBoundChannelsForProbe({ db, ...ctx }, mappingId);

      const results = [] as Awaited<ReturnType<ModelsService['probe']>>['results'];
      for (const channel of channels) {
        const startedAt = Date.now();
        try {
          const apiKey = decrypt(channel.apiKeyEnc, deps.encryptionKey);
          const ai = deps.createTester();
          const result = await ai.chat({
            channel: {
              baseUrl: channel.baseUrlOverride ?? channel.providerBaseUrl,
              apiKey,
              protocol: channel.providerProtocol,
            },
            request: {
              model: existing.realModel,
              messages: [{ role: 'user', content: '1' }],
              max_tokens: 1,
            },
            ctx: {
              requestId: `model-test-${mappingId}-${channel.channelId}`,
              model: existing.realModel,
              providerName: channel.providerProtocol,
              endpoint: 'chat',
              maxRetries: 0,
            },
          });
          if (result.status === 'success') {
            results.push({
              channelId: channel.channelId,
              channel: channel.channelName,
              ok: true,
              durationMs: Date.now() - startedAt,
              tokens:
                (result.usage?.inputTokens ?? 0) + (result.usage?.outputTokens ?? 0),
            });
          } else {
            results.push({
              channelId: channel.channelId,
              channel: channel.channelName,
              ok: false,
              durationMs: Date.now() - startedAt,
              error: result.error
                ? { code: result.error.code, message: result.error.message }
                : { code: 'empty_response', message: '上游返回空完成' },
            });
          }
        } catch (e) {
          results.push({
            channelId: channel.channelId,
            channel: channel.channelName,
            ok: false,
            durationMs: Date.now() - startedAt,
            error: {
              code: e instanceof Error && 'code' in e ? String((e as { code: unknown }).code) : 'internal',
              message: e instanceof Error ? e.message : String(e),
            },
          });
        }
      }
      return { results };
    },
  };
}
