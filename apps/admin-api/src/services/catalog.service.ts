/**
 * 模型目录服务：多源货架（渠道型 + 字典型）+ 拉取比对（三态 diff）+ 一键导入。
 *
 * 目录 = 临时货架（内存缓存，不落库）；导入落的是既有三层
 * provider/channel/model_mappings，无新概念。整个导入单事务：中途任何失败
 * （如外部名冲突）整体回滚，不留半成品（M3）。
 *
 * 源两类：
 *   channel（OpenRouter…）——真实上游：导入建 provider/渠道/绑定，上架（status 0）
 *   reference（models.dev）——行业字典：导入只落草稿（status 1 审批制），不建渠道
 *
 * 币种与追溯：目录价随源自带（USD/CNY）；USD 预填 = 目录价 × 生效汇率（基准×(1+点差)）。
 * 每次导入的 provenance（目录原价/fx 行/预填值/提交值）全量进审计——
 * 任何价格都能回答「目录 $X × 汇率 Y（来源/时间）→ 预填 → 人工确认」。
 *
 * 护栏（默认平台价能安全成立的前提）：
 *   - 价格必填（前端预填换算价，提交即确认；目录价绝不静默写入）
 *   - 渠道 rpm/进货额度预填（装配注入）；key 只在渠道首次创建时填，AES 加密
 *   - R6：isFree 由价格全零推导（不由 :free 命名约定推断）
 */
import { encrypt } from '@ai-gateway/core';
import type { Redis } from 'ioredis';
import { recordAudit } from '@ai-gateway/http';
import { createRepositories, type Db, type Repositories } from '@ai-gateway/repository';
import type { RunContext } from '@ai-gateway/service';
import { AppError } from '../http/error-map.js';
import {
  compareCatalog,
  goneFromCatalog,
  mapModelsDevCatalog,
  mapOpenAiCompatibleCatalog,
  toCny,
  type CatalogComparison,
  type CatalogCurrency,
  type CatalogItem,
} from '../domain/catalog.js';
import { isFreeByPrice } from '../domain/model-pricing.js';
import type { FxService, FxState } from './fx.service.js';

/** 目录源 adapter：拉取 + 自带映射（新增源 = 在装配注册一个 adapter） */
export interface CatalogSource {
  id: string;
  /** 展示名（前端 Tab） */
  name: string;
  kind: 'channel' | 'reference';
  /** 目录价币种（预填换算与比价口径） */
  priceCurrency: CatalogCurrency;
  /** channel 源专属：落库 provider 与渠道护栏 */
  channel?: {
    providerName: string;
    providerBaseUrl: string;
    providerProtocol: string;
    channelName: string;
    /** 导入是否需要平台 API key（首次建渠道） */
    needsKey: boolean;
  };
  /** 拉目录原始数据（公开接口） */
  fetchModels(): Promise<unknown>;
  /** 原始数据 → 标准目录项（源协议的一部分——非兼容源自带解析） */
  mapModels(raw: unknown): CatalogItem[];
}

/** 渠道型源：OpenRouter 公开目录（OpenAI 兼容面，全量——免费过滤在 UI） */
export const OPENROUTER_SOURCE: CatalogSource = {
  id: 'openrouter',
  name: 'OpenRouter',
  kind: 'channel',
  priceCurrency: 'USD',
  channel: {
    providerName: 'openrouter',
    providerBaseUrl: 'https://openrouter.ai/api',
    providerProtocol: 'openai-compatible',
    channelName: 'openrouter',
    needsKey: true,
  },
  fetchModels: async () => {
    const res = await fetch('https://openrouter.ai/api/v1/models', {
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(`openrouter catalog fetch failed: ${res.status}`);
    return res.json();
  },
  mapModels: (raw) => mapOpenAiCompatibleCatalog(raw, { currency: 'USD' }),
};

/** 字典型源：models.dev 全行业目录（导入落草稿，不建渠道；价格 $/1M） */
export const MODELS_DEV_SOURCE: CatalogSource = {
  id: 'models-dev',
  name: 'models.dev（参考字典）',
  kind: 'reference',
  priceCurrency: 'USD',
  fetchModels: async () => {
    const res = await fetch('https://models.dev/api.json', {
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(`models.dev catalog fetch failed: ${res.status}`);
    return res.json();
  },
  mapModels: (raw) => mapModelsDevCatalog(raw),
};

export interface CatalogServiceDeps {
  db: Db;
  repos?: Repositories;
  redis: Redis | null;
  /** 目录源注册表（装配注入；测试注入 mock 源） */
  sources: readonly CatalogSource[];
  /** 目录缓存 TTL（ms） */
  cacheTtlMs: number;
  /** 渠道限流预填（免费与付费同守——保守默认） */
  freeChannelRpm: number;
  /** 渠道进货额度预填 */
  freeChannelBudget: string;
  /** 渠道密钥加密密钥（单 key 单格式 enc:v1） */
  encryptionKey: string;
  /** 汇率服务（USD 预填换算与 provenance） */
  fx: FxService;
}

export interface CatalogImportModelInput {
  externalName: string;
  realModel: string;
  /** 价格必填（CNY 元/百万 token；提交即确认——预填换算值可改） */
  inputPrice: string;
  outputPrice: string;
  cacheInputPrice: string;
  cacheWritePrice: string;
  /** 上下文窗口（token）；目录带入，可空 */
  contextLength?: number | null;
}

/** comparison 载荷：目录 + 汇率快照 + 预填（UI 双币展示与提交表单共用） */
export interface CatalogComparisonPayload {
  source: string;
  kind: 'channel' | 'reference';
  priceCurrency: CatalogCurrency;
  fetchedAt: string;
  /** 汇率状态（effectiveRate null = 不可用：只展示目录原价，不预填） */
  fx: FxState;
  channelReady: boolean;
  channelRpmLimit: number | null;
  items: Array<CatalogComparison & { prefillInputCny: string | null; prefillOutputCny: string | null }>;
  /** channel 源专属：绑定到本源渠道但目录已无的映射（复核下架用） */
  gone: Array<{ mappingId: number; externalName: string; realModel: string }>;
}

export interface CatalogService {
  /** 目录源清单（前端 Tab） */
  listSources(): Array<{
    id: string;
    name: string;
    kind: 'channel' | 'reference';
    priceCurrency: CatalogCurrency;
    needsKey: boolean;
    channelName: string | null;
  }>;
  /** 拉取目录并与库内比对（三态 diff + 预填 + 汇率快照 + 消失检测） */
  comparison(ctx: RunContext, sourceId: string): Promise<CatalogComparisonPayload>;
  /** 价格溯源：某对外名历次导入/改价的 provenance 全链（目录价 × fx → 预填 → 提交） */
  priceHistory(
    ctx: RunContext,
    input: { externalName: string },
  ): Promise<
    Array<{
      action: string;
      createdAt: string;
      adminId: number | null;
      fx: { baseRate: string; effectiveRate: string | null; source: string | null; fetchedAt: string | null } | null;
      catalogPrompt: string | null;
      catalogCompletion: string | null;
      prefillInputCny: string | null;
      submittedInputCny: string;
      submittedOutputCny: string;
    }>
  >;
  /** 一键入库（channel：建渠道+绑定+上架；reference：草稿。provenance 全量审计） */
  import(
    ctx: RunContext,
    input: { adminId: number; sourceId: string; apiKey?: string; models: CatalogImportModelInput[] },
  ): Promise<{ providerId: number | null; channelId: number | null; created: number; updated: number; skipped: number }>;
}

export function createCatalogService(deps: CatalogServiceDeps): CatalogService {
  const { db } = deps;
  const repos = deps.repos ?? createRepositories();
  const sourcesById = new Map(deps.sources.map((s) => [s.id, s]));

  // 源拉取缓存（进程内存；TTL 装配注入）
  const sourceCaches = new Map<string, { fetchedAt: number; raw: unknown }>();

  function getSource(sourceId: string): CatalogSource {
    const source = sourcesById.get(sourceId);
    if (!source) {
      throw new AppError(404, 'catalog_source_not_found', `未知的目录源：${sourceId}`);
    }
    return source;
  }

  async function fetchSourceModels(source: CatalogSource): Promise<{ fetchedAt: number; raw: unknown }> {
    const cached = sourceCaches.get(source.id);
    if (cached && Date.now() - cached.fetchedAt < deps.cacheTtlMs) {
      return { fetchedAt: cached.fetchedAt, raw: cached.raw };
    }
    const raw = await source.fetchModels();
    const entry = { fetchedAt: Date.now(), raw };
    sourceCaches.set(source.id, entry);
    return entry;
  }

  return {
    listSources() {
      return deps.sources.map((s) => ({
        id: s.id,
        name: s.name,
        kind: s.kind,
        priceCurrency: s.priceCurrency,
        needsKey: s.channel?.needsKey === true,
        channelName: s.channel?.channelName ?? null,
      }));
    },

    async comparison(ctx, sourceId) {
      const source = getSource(sourceId);
      const { fetchedAt, raw } = await fetchSourceModels(source);
      const items = source.mapModels(raw);
      const fxState = await deps.fx.state(ctx);
      const existing = await repos.modelMapping.listEnabledByRealModels(
        { db, ...ctx },
        items.map((i) => i.realModel),
      );
      const compared = compareCatalog(
        items,
        existing.map((e) => ({
          externalName: e.externalName,
          realModel: e.realModel,
          inputPrice: e.inputPrice,
          outputPrice: e.outputPrice,
        })),
        { effectiveRate: fxState.effectiveRate },
      ).map((item) => ({
        ...item,
        prefillInputCny: toCny(item.catalogPrompt, item.currency, fxState.effectiveRate),
        prefillOutputCny: toCny(item.catalogCompletion, item.currency, fxState.effectiveRate),
      }));

      let channelReady = false;
      let channelRpmLimit: number | null = null;
      let gone: CatalogComparisonPayload['gone'] = [];
      if (source.channel) {
        const channelRow = await repos.channel.findChannelByName({ db, ...ctx }, source.channel.channelName);
        channelReady = channelRow != null;
        channelRpmLimit = channelRow?.rpmLimit ?? null;
        if (channelRow != null) {
          const realModels = new Set(items.map((i) => i.realModel));
          gone = goneFromCatalog(
            await repos.modelMapping.listMappingRowsByChannelId({ db, ...ctx }, channelRow.id),
            realModels,
          );
        }
      }
      return {
        source: source.id,
        kind: source.kind,
        priceCurrency: source.priceCurrency,
        fetchedAt: new Date(fetchedAt).toISOString(),
        fx: fxState,
        channelReady,
        channelRpmLimit,
        items: compared,
        gone,
      };
    },

    async priceHistory(ctx, input) {
      const rows = await repos.auditLog.listCatalogPriceHistory({ db, ...ctx }, input);
      return rows.map((r) => {
        const detail = (r.detail ?? {}) as {
          fx: { baseRate: string; effectiveRate: string | null; source: string | null; fetchedAt: string | null } | null;
          models: Array<{
            externalName: string;
            catalogPrompt: string | null;
            catalogCompletion: string | null;
            prefillInputCny: string | null;
            submittedInputCny: string;
            submittedOutputCny: string;
          }>;
        };
        const entry = detail.models?.find((m) => m.externalName === input.externalName) ?? null;
        return {
          action: r.action,
          createdAt: r.createdAt.toISOString(),
          adminId: r.adminId,
          fx: detail.fx ?? null,
          catalogPrompt: entry?.catalogPrompt ?? null,
          catalogCompletion: entry?.catalogCompletion ?? null,
          prefillInputCny: entry?.prefillInputCny ?? null,
          submittedInputCny: entry?.submittedInputCny ?? '0',
          submittedOutputCny: entry?.submittedOutputCny ?? '0',
        };
      });
    },

    async import(ctx, input) {
      if (input.models.length === 0) {
        throw new AppError(400, 'catalog_empty', '至少选择一个模型');
      }
      const source = getSource(input.sourceId);
      if (source.channel == null && source.kind !== 'reference') {
        throw new AppError(400, 'catalog_source_invalid', '源缺少渠道与字典配置');
      }

      // provenance：服务端重算预填（与 comparison 同一换算点）
      const { fetchedAt, raw } = await fetchSourceModels(source);
      const items = source.mapModels(raw);
      const fxState = await deps.fx.state(ctx);
      const byReal = new Map(items.map((i) => [i.realModel, i]));
      const prefillOf = (realModel: string, price: string): string | null =>
        toCny(price, source.priceCurrency, fxState.effectiveRate);

      const result = await db.transaction(async (tx) => {
        const c = { db: tx, ...ctx };
        let providerId: number | null = null;
        let channelId: number | null = null;

        if (source.channel) {
          // 渠道型：provider find-or-create（目录源即供应商）
          let provider = await repos.provider.findByName(c, source.channel.providerName);
          if (!provider) {
            provider = await repos.provider.insert(c, {
              name: source.channel.providerName,
              protocol: source.channel.providerProtocol,
              baseUrl: source.channel.providerBaseUrl,
            });
          }
          providerId = provider.id;

          // 渠道 find-or-create（首次需要平台 key；复用不覆盖已存 key）
          const existingChannel = await repos.channel.findChannelByName(c, source.channel.channelName);
          if (existingChannel) {
            channelId = existingChannel.id;
          } else {
            if (!input.apiKey && source.channel.needsKey) {
              throw new AppError(400, 'api_key_required', `首次从 ${source.name} 导入需要填写平台 API Key（用于创建渠道）`);
            }
            const created = await repos.channel.insertChannel(c, {
              providerId: provider.id,
              name: source.channel.channelName,
              apiKeyEnc: encrypt(input.apiKey ?? 'no-key-required', deps.encryptionKey),
              rpmLimit: deps.freeChannelRpm,
              upstreamBudget: deps.freeChannelBudget,
            });
            channelId = created.id;
          }
        }

        let created = 0;
        let updated = 0;
        let skipped = 0;
        for (const m of input.models) {
          const existingMapping = await repos.modelMapping.findByExternalName(c, m.externalName);
          const prices = {
            inputPrice: m.inputPrice,
            outputPrice: m.outputPrice,
            cacheInputPrice: m.cacheInputPrice,
            cacheWritePrice: m.cacheWritePrice,
          };

          if (source.kind === 'reference') {
            // 字典型：草稿态导入（审批制）——已存在跳过不覆盖（价格属资金语义，改价走正式编辑）
            if (existingMapping) {
              skipped += 1;
              continue;
            }
            await repos.modelMapping.insertMapping(c, {
              externalName: m.externalName,
              realModel: m.realModel,
              contextLength: m.contextLength ?? null,
              ...prices,
              isFree: isFreeByPrice(prices),
              status: 1,
            });
            created += 1;
            continue;
          }

          if (existingMapping) {
            if (existingMapping.realModel !== m.realModel) {
              // 外部名被其他真实模型占用 → 整体回滚（M3：不留半成品）
              throw new AppError(409, 'external_name_conflict', `对外名 ${m.externalName} 已绑定 ${existingMapping.realModel}，请换一个名字`);
            }
            // 重复导入 = 价格更新确认（同一真实模型）；isFree 按价格全零重推导
            await repos.modelMapping.updateMapping(c, {
              mappingId: existingMapping.id,
              patch: {
                ...prices,
                isFree: isFreeByPrice(prices),
                ...(m.contextLength != null ? { contextLength: m.contextLength } : {}),
              },
            });
            await repos.modelMapping.ensureModelChannelBinding(c, {
              mappingId: existingMapping.id,
              channelId: channelId!,
            });
            updated += 1;
          } else {
            const inserted = await repos.modelMapping.insertMapping(c, {
              externalName: m.externalName,
              realModel: m.realModel,
              contextLength: m.contextLength ?? null,
              ...prices,
              isFree: isFreeByPrice(prices),
            });
            await repos.modelMapping.ensureModelChannelBinding(c, {
              mappingId: inserted.id,
              channelId: channelId!,
            });
            created += 1;
          }
        }
        return { providerId, channelId, created, updated, skipped };
      });

      // 定价审计：目录原价 × fx → 预填 → 提交（全链可复原）
      await recordAudit(db, {
        actor: 'admin',
        adminId: input.adminId,
        action: source.kind === 'reference' ? 'model_catalog.import_draft' : 'model_catalog.import',
        targetType: source.kind === 'reference' ? 'catalog' : 'provider',
        targetId: String(result.providerId ?? source.id),
        detail: {
          source: source.id,
          kind: source.kind,
          currency: source.priceCurrency,
          fx:
            fxState.baseRate == null
              ? null
              : {
                  fxRateId: fxState.fxRateId,
                  baseRate: fxState.baseRate,
                  effectiveRate: fxState.effectiveRate,
                  source: fxState.source,
                  fetchedAt: fxState.fetchedAt,
                  bufferPct: fxState.bufferPct,
                },
          fetchedAt: new Date(fetchedAt).toISOString(),
          created: result.created,
          updated: result.updated,
          skipped: result.skipped,
          models: input.models.map((m) => {
            const catalogItem = byReal.get(m.realModel);
            return {
              externalName: m.externalName,
              realModel: m.realModel,
              catalogPrompt: catalogItem?.catalogPrompt ?? null,
              catalogCompletion: catalogItem?.catalogCompletion ?? null,
              prefillInputCny: catalogItem ? prefillOf(m.realModel, catalogItem.catalogPrompt) : null,
              prefillOutputCny: catalogItem ? prefillOf(m.realModel, catalogItem.catalogCompletion) : null,
              submittedInputCny: m.inputPrice,
              submittedOutputCny: m.outputPrice,
            };
          }),
        },
      });
      return result;
    },
  };
}
