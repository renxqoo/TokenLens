/**
 * 模型目录语义（多源货架 + 三态 diff + provenance 审计）：
 *   - 纯函数：对外名建议 / OpenAI 兼容全量映射 / models.dev 字典映射 /
 *     换算（toCny）/ 三态 diff（USD 换算比价、汇率缺失退化）/ 消失检测
 *   - channel 导入：find-or-create provider/channel、重复=价格更新确认、
 *     外部名冲突 409 整体回滚（M3）、缺 key 400
 *   - reference 导入（models.dev）：草稿态 status=1、不建渠道、重复 skip
 *   - provenance 审计：目录原价 × fx → 预填 → 提交 全链落审计
 */
import { describe, expect, it } from 'vitest';
import { desc, eq, inArray } from 'drizzle-orm';
import { Decimal } from '@ai-gateway/domain';
import { auditLogs, channels, modelChannels, modelMappings, providers } from '@ai-gateway/db';
import type { CatalogSource } from '../services/catalog.service.js';
import {
  compareCatalog,
  goneFromCatalog,
  mapModelsDevCatalog,
  mapOpenAiCompatibleCatalog,
  suggestExternalName,
  toCny,
} from '../domain/catalog.js';
import {
  buildTestApp,
  db,
  MOCK_FX_RATE,
  newAdmin,
  trackChannel,
  trackMapping,
  trackProvider,
  uid,
} from './helpers.js';

/** OpenRouter 形状的目录夹具：2 免费 + 1 付费（免费过滤已上移 UI） */
const RAW_CATALOG = {
  data: [
    {
      id: 'meta-llama/llama-3.3-70b-instruct:free',
      name: 'Llama 3.3 70B Instruct',
      context_length: 65536,
      pricing: { prompt: '0', completion: '0' },
    },
    {
      id: 'qwen/qwen-2.5-72b-instruct:free',
      name: 'Qwen2.5 72B',
      context_length: 32768,
      pricing: { prompt: '0', completion: '0' },
    },
    {
      id: 'openai/gpt-4o',
      name: 'GPT-4o',
      pricing: { prompt: '0.0000025', completion: '0.00001', cache_read: '0.00000125' },
    },
  ],
};

/** models.dev api.json 形状夹具 */
const RAW_MODELS_DEV = {
  __meta: { schema: 'https://models.dev' },
  anthropic: {
    models: {
      'claude-sonnet-4': {
        name: 'Claude Sonnet 4',
        limit: { context: 200_000 },
        cost: { input: 3, output: 15, cache_read: 0.3, cache_write: 3.75 },
      },
    },
  },
};

/** 目录导入落库行的清理收编（provider/channel 按源命名；映射按本批对外名） */
async function trackImported(source: CatalogSource, externalNames: readonly string[]): Promise<void> {
  if (source.channel) {
    const [p] = await db.select({ id: providers.id }).from(providers).where(eq(providers.name, source.channel.providerName));
    if (p) trackProvider(p.id);
    const [ch] = await db.select({ id: channels.id }).from(channels).where(eq(channels.name, source.channel.channelName));
    if (ch) trackChannel(ch.id);
  }
  if (externalNames.length) {
    const ms = await db
      .select({ id: modelMappings.id })
      .from(modelMappings)
      .where(inArray(modelMappings.externalName, [...externalNames]));
    for (const m of ms) trackMapping(m.id);
  }
}

function mockSource(overrides: Partial<CatalogSource> = {}): CatalogSource {
  return {
    id: 'mock-src',
    name: 'Mock 源',
    kind: 'channel',
    priceCurrency: 'USD',
    channel: {
      providerName: uid('src-prov'),
      providerBaseUrl: 'https://mock.example.com/v1',
      providerProtocol: 'openai-compatible',
      channelName: uid('free-ch'),
      needsKey: true,
    },
    fetchModels: async () => RAW_CATALOG,
    mapModels: (raw) => mapOpenAiCompatibleCatalog(raw, { currency: 'USD' }),
    ...overrides,
  };
}

function mockReferenceSource(): CatalogSource {
  return {
    id: 'mock-ref',
    name: 'Mock 字典',
    kind: 'reference',
    priceCurrency: 'USD',
    fetchModels: async () => RAW_MODELS_DEV,
    mapModels: (raw) => mapModelsDevCatalog(raw),
  };
}

describe('目录纯函数', () => {
  it('suggestExternalName：去厂商前缀与 :free 后缀', () => {
    expect(suggestExternalName('a/b/c:free')).toBe('c');
    expect(suggestExternalName('solo-model:free')).toBe('solo-model');
    expect(suggestExternalName('meta-llama/llama-3.3-70b-instruct:free')).toBe('llama-3.3-70b-instruct');
  });

  it('mapOpenAiCompatibleCatalog：全量返回（免费+付费），币种与缓存价透传', () => {
    const items = mapOpenAiCompatibleCatalog(RAW_CATALOG, { currency: 'USD' });
    expect(items).toHaveLength(3);
    expect(items[0]).toMatchObject({
      realModel: 'meta-llama/llama-3.3-70b-instruct:free',
      suggestedName: 'llama-3.3-70b-instruct',
      contextLength: 65536,
    });
    const paid = items.find((i) => i.realModel === 'openai/gpt-4o')!;
    expect(paid.catalogPrompt).toBe('2.5'); // 每 token $0.0000025 归一每百万
    expect(paid.catalogCacheRead).toBe('1.25');
    expect(paid.catalogCacheWrite).toBeNull();
    expect(mapOpenAiCompatibleCatalog({}, { currency: 'USD' })).toEqual([]);
  });

  it('mapModelsDevCatalog：provider/id 唯一化 + limit.context + cost 四价；__meta 跳过', () => {
    const items = mapModelsDevCatalog(RAW_MODELS_DEV);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      realModel: 'anthropic/claude-sonnet-4',
      displayName: 'Claude Sonnet 4',
      contextLength: 200_000,
      currency: 'USD',
      catalogPrompt: '3',
      catalogCompletion: '15',
      catalogCacheRead: '0.3',
      catalogCacheWrite: '3.75',
      suggestedName: 'claude-sonnet-4',
    });
    expect(mapModelsDevCatalog(null)).toEqual([]);
  });

  it('mapModelsDevCatalog：空 id 跳过、无名回退 id、非法窗口归 null', () => {
    const items = mapModelsDevCatalog({
      p: {
        models: {
          '': { cost: { input: 1 } },
          ok: { limit: { context: 0 }, cost: {} },
        },
      },
    });
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ displayName: 'ok', contextLength: null });
  });

  it('compareCatalog：带内波动（±5%）判 same 且记小幅 driftPct；CNY 源直比', () => {
    const inBand = compareCatalog(
      [{ realModel: 'x', displayName: 'x', contextLength: null, currency: 'CNY', catalogPrompt: '10.2', catalogCompletion: '10.2', catalogCacheRead: null, catalogCacheWrite: null, suggestedName: 'x' }],
      [{ externalName: 'x', realModel: 'x', inputPrice: '10', outputPrice: '10' }],
      { effectiveRate: '7.2' },
    );
    expect(inBand[0]!.diff).toBe('same');
    expect(inBand[0]!.driftPct).toBe(2);
  });

  it('toCny：CNY 原样；USD × 生效汇率；汇率缺失 null', () => {
    expect(toCny('3', 'CNY', null)).toBe('3');
    expect(Number(toCny('3', 'USD', '7.2'))).toBeCloseTo(21.6, 8);
    expect(toCny('3', 'USD', null)).toBeNull();
  });

  it('compareCatalog：三态 diff + 漂移百分比 + priceWarning + isFree', () => {
    const items = mapOpenAiCompatibleCatalog(RAW_CATALOG, { currency: 'USD' });
    // 已导入免费模型：回填卖价、无警告
    const compared = compareCatalog(
      items,
      [{ externalName: 'llama', realModel: 'meta-llama/llama-3.3-70b-instruct:free', inputPrice: '0', outputPrice: '0' }],
      { effectiveRate: '7.2' },
    );
    const imported = compared.find((i) => i.imported != null)!;
    expect(imported.imported!.externalName).toBe('llama');
    expect(imported.priceWarning).toBe(false);
    expect(imported.isFree).toBe(true);
    expect(compared.find((i) => i.realModel === 'openai/gpt-4o')!.diff).toBe('new');

    // USD 比价：我们卖 $2/$8（≈14.4/57.6 CNY@7.2），目录 $2.5/$10 → 上游贵 25% → price_up
    const drifted = compareCatalog(
      [{ ...items[2]!, currency: 'USD' }],
      [{ externalName: 'g4o', realModel: 'openai/gpt-4o', inputPrice: '14.4', outputPrice: '57.6' }],
      { effectiveRate: '7.2' },
    );
    expect(drifted[0]!.diff).toBe('price_up');
    expect(drifted[0]!.driftPct).toBeCloseTo(25, 0);

    // 目录降价 → price_down；汇率缺失 → same（无法同币比较）
    const lowered = compareCatalog(
      [{ ...items[2]!, catalogPrompt: '0.000001', catalogCompletion: '0.000004' }],
      [{ externalName: 'g4o', realModel: 'openai/gpt-4o', inputPrice: '14.4', outputPrice: '57.6' }],
      { effectiveRate: '7.2' },
    );
    expect(lowered[0]!.diff).toBe('price_down');
    const noFx = compareCatalog(
      [{ ...items[2]! }],
      [{ externalName: 'g4o', realModel: 'openai/gpt-4o', inputPrice: '14.4', outputPrice: '57.6' }],
      { effectiveRate: null },
    );
    expect(noFx[0]!.diff).toBe('same');
    expect(noFx[0]!.driftPct).toBeNull();

    // 上游收费而我们 0 卖 → priceWarning
    const warned = compareCatalog(
      [items[2]!],
      [{ externalName: 'g4o', realModel: 'openai/gpt-4o', inputPrice: '0', outputPrice: '0' }],
      { effectiveRate: '7.2' },
    );
    expect(warned[0]!.priceWarning).toBe(true);
  });

  it('goneFromCatalog：目录已无的绑定行浮出', () => {
    const gone = goneFromCatalog(
      [
        { mappingId: 1, externalName: 'a', realModel: 'x' },
        { mappingId: 2, externalName: 'b', realModel: 'y' },
      ],
      new Set(['x']),
    );
    expect(gone).toEqual([{ mappingId: 2, externalName: 'b', realModel: 'y' }]);
  });
});

describe('channel 导入（mock 源，真 PG）', () => {
  it('首次导入建 provider/channel/映射/绑定；重复导入复用并更新价格；isFree 随价翻转', async () => {
    const source = mockSource();
    const { request } = buildTestApp({ sources: [source] });
    const { token } = await newAdmin();
    const externalName = uid('ext');

    const first = await request('/v1/model-catalog/import', {
      token,
      body: {
        sourceId: source.id,
        apiKey: 'sk-or-v1-test',
        models: [
          { externalName, realModel: 'meta-llama/llama-3.3-70b-instruct:free', inputPrice: 0, outputPrice: 0, cacheInputPrice: 0, cacheWritePrice: 0, contextLength: 65536 },
        ],
      },
    });
    expect(first.status).toBe(200);
    const firstBody = (await first.json()) as { providerId: number; channelId: number; created: number; updated: number };
    expect(firstBody).toMatchObject({ created: 1, updated: 0 });
    await trackImported(source, [externalName]);

    const [provider] = await db.select().from(providers).where(eq(providers.id, firstBody.providerId));
    expect(provider!.name).toBe(source.channel!.providerName);
    const [channel] = await db.select().from(channels).where(eq(channels.id, firstBody.channelId));
    expect(Number(channel!.rpmLimit)).toBe(20);
    expect(channel!.apiKeyEnc).toMatch(/^enc:v1:/);

    const [mapping] = await db.select().from(modelMappings).where(eq(modelMappings.externalName, externalName));
    expect(mapping!.isFree).toBe(true);
    expect(mapping!.contextLength).toBe(65536);
    const bindings = await db.select().from(modelChannels).where(eq(modelChannels.mappingId, mapping!.id));
    expect(bindings).toHaveLength(1);

    // provenance 审计：目录原价 → fx（mock 7.2）→ 预填 → 提交
    const [audit] = await db.select().from(auditLogs).where(eq(auditLogs.action, 'model_catalog.import')).orderBy(desc(auditLogs.id));
    expect(audit).toBeTruthy();
    const detail = audit!.detail as { fx: { baseRate: string } | null; models: Array<{ catalogPrompt: string; prefillInputCny: string | null; submittedInputCny: string }> };
    expect(detail.fx?.baseRate).toBe(MOCK_FX_RATE);
    const m0 = detail.models.find((m) => m.submittedInputCny === '0')!;
    expect(m0.catalogPrompt).toBe('0');
    expect(m0.prefillInputCny).toBe('0');

    // 重复导入（无 key）复用渠道；价格更新确认；isFree 翻 false
    const second = await request('/v1/model-catalog/import', {
      token,
      body: {
        sourceId: source.id,
        models: [
          { externalName, realModel: 'meta-llama/llama-3.3-70b-instruct:free', inputPrice: 5, outputPrice: 5, cacheInputPrice: 5, cacheWritePrice: 0 },
        ],
      },
    });
    expect(second.status).toBe(200);
    const secondBody = (await second.json()) as typeof firstBody;
    expect(secondBody).toMatchObject({ providerId: firstBody.providerId, channelId: firstBody.channelId, created: 0, updated: 1 });
    const [updatedMapping] = await db.select().from(modelMappings).where(eq(modelMappings.externalName, externalName));
    expect(new Decimal(updatedMapping!.inputPrice).eq(5)).toBe(true);
    expect(updatedMapping!.isFree).toBe(false);
  });

  it('首次导入缺 key → 400 api_key_required', async () => {
    const source = mockSource();
    const { request } = buildTestApp({ sources: [source] });
    const { token } = await newAdmin();
    const res = await request('/v1/model-catalog/import', {
      token,
      body: {
        sourceId: source.id,
        models: [{ externalName: 'x', realModel: 'y', inputPrice: 0, outputPrice: 0, cacheInputPrice: 0, cacheWritePrice: 0 }],
      },
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('api_key_required');
  });

  it('外部名冲突（同对外名绑不同真实模型）→ 409 且整体回滚零残留', async () => {
    const source = mockSource();
    const { request } = buildTestApp({ sources: [source] });
    const { token } = await newAdmin();
    const { newMappingRow } = await import('./helpers.js');

    const conflictExt = uid('conflict');
    await newMappingRow({ externalName: conflictExt, realModel: uid('occupied') });

    const newExt = uid('fresh');
    const res = await request('/v1/model-catalog/import', {
      token,
      body: {
        sourceId: source.id,
        apiKey: 'sk-x',
        models: [
          { externalName: newExt, realModel: uid('r1'), inputPrice: 0, outputPrice: 0, cacheInputPrice: 0, cacheWritePrice: 0 },
          { externalName: conflictExt, realModel: uid('r2'), inputPrice: 0, outputPrice: 0, cacheInputPrice: 0, cacheWritePrice: 0 },
        ],
      },
    });
    expect(res.status).toBe(409);
    const [provider] = await db.select().from(providers).where(eq(providers.name, source.channel!.providerName));
    expect(provider).toBeUndefined();
    const [channel] = await db.select().from(channels).where(eq(channels.name, source.channel!.channelName));
    expect(channel).toBeUndefined();
    const [mapping] = await db.select().from(modelMappings).where(eq(modelMappings.externalName, newExt));
    expect(mapping).toBeUndefined();
  });
});

describe('reference 导入（models.dev 形状，草稿审批制）', () => {
  it('导入落 status=1 草稿、不建 provider/channel；重复导入 skip 不覆盖', async () => {
    const source = mockReferenceSource();
    const { request } = buildTestApp({ sources: [source] });
    const { token } = await newAdmin();
    const externalName = uid('draft');

    const first = await request('/v1/model-catalog/import', {
      token,
      body: {
        sourceId: source.id,
        models: [
          { externalName, realModel: 'anthropic/claude-sonnet-4', inputPrice: 21.6, outputPrice: 108, cacheInputPrice: 2.16, cacheWritePrice: 27, contextLength: 200_000 },
        ],
      },
    });
    expect(first.status).toBe(200);
    const body = (await first.json()) as { providerId: number | null; channelId: number | null; created: number };
    expect(body).toMatchObject({ providerId: null, channelId: null, created: 1 });
    await trackImported(source, [externalName]);

    const [mapping] = await db.select().from(modelMappings).where(eq(modelMappings.externalName, externalName));
    expect(mapping!.status).toBe(1); // 草稿态：审批后手动上架
    expect(mapping!.contextLength).toBe(200_000);
    expect(new Decimal(mapping!.cacheWritePrice).eq(27)).toBe(true);

    // provenance 审计（字典型动作名单列）
    const [audit] = await db.select().from(auditLogs).where(eq(auditLogs.action, 'model_catalog.import_draft')).orderBy(desc(auditLogs.id));
    const detail = audit!.detail as { models: Array<{ catalogPrompt: string; prefillInputCny: string | null }> };
    expect(detail.models[0]!.catalogPrompt).toBe('3');
    expect(Number(detail.models[0]!.prefillInputCny)).toBeCloseTo(21.6, 6);

    // 重复导入 → skip（草稿价格不被静默覆盖——改价走正式编辑）
    const second = await request('/v1/model-catalog/import', {
      token,
      body: {
        sourceId: source.id,
        models: [
          { externalName, realModel: 'anthropic/claude-sonnet-4', inputPrice: 99, outputPrice: 99, cacheInputPrice: 99, cacheWritePrice: 99 },
        ],
      },
    });
    expect(second.status).toBe(200);
    expect(((await second.json()) as { skipped: number }).skipped).toBe(1);
    const [unchanged] = await db.select().from(modelMappings).where(eq(modelMappings.externalName, externalName));
    expect(new Decimal(unchanged!.inputPrice).eq(21.6)).toBe(true);
  });
});

describe('比对接口（三态 diff + fx 快照 + 消失检测）', () => {
  it('comparison 返回换算预填与 diff；channel 源带 gone', async () => {
    const source = mockSource();
    const { request } = buildTestApp({ sources: [source] });
    const { token } = await newAdmin();
    // 导入付费模型挂旧价（目录 $2.5/$10 @7.2 → 18/72；我们卖 14.4/57.6 → price_up）
    const externalName = uid('ext');
    await request('/v1/model-catalog/import', {
      token,
      body: {
        sourceId: source.id,
        apiKey: 'sk-x',
        models: [{ externalName, realModel: 'openai/gpt-4o', inputPrice: 14.4, outputPrice: 57.6, cacheInputPrice: 0, cacheWritePrice: 0 }],
      },
    });
    await trackImported(source, [externalName]);

    const res = await request(`/v1/model-catalog/${source.id}`, { token });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      kind: string;
      fx: { baseRate: string | null; effectiveRate: string | null };
      channelReady: boolean;
      items: Array<{ realModel: string; diff: string; prefillInputCny: string | null }>;
      gone: unknown[];
    };
    expect(body.kind).toBe('channel');
    expect(body.fx.baseRate).toBe(MOCK_FX_RATE);
    expect(body.channelReady).toBe(true);
    expect(body.items).toHaveLength(3); // 全量货架（免费+付费）
    const g4o = body.items.find((i) => i.realModel === 'openai/gpt-4o')!;
    expect(g4o.diff).toBe('price_up');
    expect(Number(g4o.prefillInputCny)).toBeCloseTo(2.5 * 7.2, 6);
    expect(Array.isArray(body.gone)).toBe(true);
  });

  it('价格溯源：reference 导入后按对外名可查 provenance 全链', async () => {
    const source = mockReferenceSource();
    const { request } = buildTestApp({ sources: [source] });
    const { token } = await newAdmin();
    const externalName = uid('trace');
    await request('/v1/model-catalog/import', {
      token,
      body: {
        sourceId: source.id,
        models: [
          { externalName, realModel: 'anthropic/claude-sonnet-4', inputPrice: 22, outputPrice: 108, cacheInputPrice: 2.16, cacheWritePrice: 27, contextLength: 200_000 },
        ],
      },
    });
    await trackImported(source, [externalName]);
    const res = await request(`/v1/model-catalog/price-history?externalName=${encodeURIComponent(externalName)}`, { token });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      entries: Array<{ action: string; fx: { baseRate: string } | null; catalogPrompt: string | null; prefillInputCny: string | null; submittedInputCny: string }>;
    };
    expect(body.entries.length).toBeGreaterThanOrEqual(1);
    const latest = body.entries[0]!;
    expect(latest.action).toBe('model_catalog.import_draft');
    expect(latest.fx?.baseRate).toBe(MOCK_FX_RATE);
    expect(latest.catalogPrompt).toBe('3');
    expect(Number(latest.prefillInputCny)).toBeCloseTo(21.6, 6);
    expect(latest.submittedInputCny).toBe('22');
    // 缺参 400
    const bad = await request('/v1/model-catalog/price-history', { token });
    expect(bad.status).toBe(400);
  });

  it('未知源 → 404 catalog_source_not_found；源清单回显 kind/priceCurrency', async () => {
    const source = mockSource();
    const { request } = buildTestApp({ sources: [source, mockReferenceSource()] });
    const { token } = await newAdmin();
    const res = await request('/v1/model-catalog/no-such-source', { token });
    expect(res.status).toBe(404);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('catalog_source_not_found');

    const list = await request('/v1/model-catalog/sources', { token });
    const body = (await list.json()) as { sources: Array<{ id: string; kind: string; priceCurrency: string }> };
    expect(body.sources).toHaveLength(2);
    expect(body.sources.map((s) => s.kind).toSorted()).toEqual(['channel', 'reference']);
  });
});
