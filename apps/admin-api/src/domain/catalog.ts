/**
 * 模型目录纯函数（单 app 域）：目录源货架（全量，免费/付费由消费方筛）+
 * 库内三态 diff（new / same / price_up / price_down）。
 * 目录 = 临时货架（内存缓存，不落库）；导入落的是既有三层
 * provider/channel/model_mappings，无新概念。
 * 币种：目录价随源自带（USD/CNY）；跨币比价与预填换算由调用方传入生效汇率。
 */
export type CatalogCurrency = 'USD' | 'CNY';

/** 目录价与库内卖价的差异态（换算同币后比较，5% 带宽抗汇率噪声） */
export type CatalogDiffState = 'new' | 'same' | 'price_up' | 'price_down';

export interface CatalogItem {
  /** 上游真实模型 id（channel 源）或 provider/id 唯一化（reference 源） */
  realModel: string;
  displayName: string;
  contextLength: number | null;
  currency: CatalogCurrency;
  /** 目录参考输入价（源币种/百万 token；字符串保形，"0"=免费） */
  catalogPrompt: string;
  catalogCompletion: string;
  catalogCacheRead: string | null;
  catalogCacheWrite: string | null;
  /** 对外名建议（去厂商前缀与 :free 后缀） */
  suggestedName: string;
}

export interface CatalogComparison extends CatalogItem {
  /** 已导入回填（我们的卖价，CNY） */
  imported: { externalName: string; inputPrice: string; outputPrice: string } | null;
  diff: CatalogDiffState;
  /** 目录换算价相对我们卖价的偏离（%，正=上游比我们贵）；无法判定为 null */
  driftPct: number | null;
  /** 免费判定：目录输入输出价均为 0（:free 变体公开特征；CNY 源同构） */
  isFree: boolean;
  /** 目录收费而我们免费卖 → 亏钱风险，页面标红 */
  priceWarning: boolean;
}

/** 对外名建议：`meta-llama/llama-3.3-70b-instruct:free` → `llama-3.3-70b-instruct` */
export function suggestExternalName(id: string): string {
  const stripped = id.replace(/:free$/, '');
  const segments = stripped.split('/');
  return (segments[segments.length - 1] || stripped).slice(0, 64);
}

function asPrice(v: unknown): string {
  return typeof v === 'string' && v.length > 0 ? v : typeof v === 'number' && Number.isFinite(v) ? String(v) : '0';
}

function asOptionalPrice(v: unknown): string | null {
  if (typeof v !== 'string' && typeof v !== 'number') return null;
  const s = asPrice(v);
  return Number(s) > 0 ? s : null;
}

/** 每 token 价 → 每百万价（0/缺省保持 null——免费无缓存价语义） */
function scalePerMillion(v: unknown): string | null {
  const s = asOptionalPrice(v);
  return s == null ? null : String(Number(s) * USD_PER_TOKEN_TO_PER_MILLION);
}

/**
 * OpenAI 兼容 models 列表 → 全量目录（OpenRouter/SiliconFlow/Groq 同构）。
 * 免费过滤已上移到消费方（UI 筛选「免费/全部」）——付费入库链路本就完整。
 * 价格口径归一：OpenRouter /v1/models 的 pricing 为「每 token 美元」，统一换算成
 * 「每百万 token」（×1e6）——与 models.dev 的 cost 口径一致，预填/比价不再有量纲差。
 */
const USD_PER_TOKEN_TO_PER_MILLION = 1_000_000;
export function mapOpenAiCompatibleCatalog(
  raw: unknown,
  opts: { currency: CatalogCurrency; realModelPrefix?: string },
): CatalogItem[] {
  const data = (raw as { data?: unknown[] } | null)?.data;
  if (!Array.isArray(data)) return [];
  const items: CatalogItem[] = [];
  for (const m of data) {
    const row = m as {
      id?: unknown;
      name?: unknown;
      context_length?: unknown;
      pricing?: { prompt?: unknown; completion?: unknown };
    };
    if (typeof row.id !== 'string' || row.id.length === 0) continue;
    const realModel = opts.realModelPrefix ? `${opts.realModelPrefix}${row.id}` : row.id;
    items.push({
      realModel,
      displayName: typeof row.name === 'string' ? row.name : row.id,
      contextLength: typeof row.context_length === 'number' ? row.context_length : null,
      currency: opts.currency,
      catalogPrompt: String(Number(asPrice(row.pricing?.prompt)) * USD_PER_TOKEN_TO_PER_MILLION),
      catalogCompletion: String(Number(asPrice(row.pricing?.completion)) * USD_PER_TOKEN_TO_PER_MILLION),
      catalogCacheRead: scalePerMillion((row.pricing as { cache_read?: unknown } | undefined)?.cache_read),
      catalogCacheWrite: scalePerMillion((row.pricing as { cache_write?: unknown } | undefined)?.cache_write),
      suggestedName: suggestExternalName(row.id),
    });
  }
  return items;
}

/**
 * models.dev api.json → 全量参考目录（字典型源；不建渠道，导入落草稿）。
 * 形状：{ [provider]: { models: { [id]: { name, limit.context, cost.{input,output,cache_read,cache_write} } } } }
 */
export function mapModelsDevCatalog(raw: unknown): CatalogItem[] {
  const data = raw as Record<string, { models?: Record<string, Record<string, unknown>> }> | null;
  if (!data || typeof data !== 'object') return [];
  const items: CatalogItem[] = [];
  for (const [provider, pd] of Object.entries(data)) {
    if (provider === '__meta' || provider === '$schema') continue;
    for (const [id, m] of Object.entries(pd.models ?? {})) {
      if (typeof id !== 'string' || id.length === 0) continue;
      const limit = (m.limit ?? {}) as { context?: unknown };
      const cost = (m.cost ?? {}) as Record<string, unknown>;
      items.push({
        realModel: `${provider}/${id}`,
        displayName: typeof m.name === 'string' && m.name ? m.name : id,
        contextLength: typeof limit.context === 'number' && limit.context > 0 ? limit.context : null,
        currency: 'USD',
        catalogPrompt: asPrice(cost.input),
        catalogCompletion: asPrice(cost.output),
        catalogCacheRead: asOptionalPrice(cost.cache_read),
        catalogCacheWrite: asOptionalPrice(cost.cache_write),
        suggestedName: suggestExternalName(id),
      });
    }
  }
  return items;
}

/** 目录参考输入价换算到 CNY（预填与比价共用的唯一换算点；CNY 源原样返回） */
export function toCny(price: string, currency: CatalogCurrency, effectiveRate: string | null): string | null {
  if (currency === 'CNY') return price;
  if (effectiveRate == null) return null;
  return String(Number(price) * Number(effectiveRate));
}

/** 比价带宽：±5% 内视为 same（汇率与目录价的日常波动不产生噪声 diff） */
const DRIFT_BAND = 0.05;

/**
 * 目录 × 库内映射 → 三态 diff + 回填 + 漂移警告（纯函数）。
 * USD 源需传生效汇率（null 时 diff 退化为 same——无法同币比较）。
 */
export function compareCatalog(
  items: readonly CatalogItem[],
  existing: ReadonlyArray<{
    externalName: string;
    realModel: string;
    inputPrice: string;
    outputPrice: string;
  }>,
  fx: { effectiveRate: string | null },
): CatalogComparison[] {
  const byReal = new Map(existing.map((e) => [e.realModel, e]));
  return items.map((item) => {
    const ours = byReal.get(item.realModel) ?? null;
    const catalogPromptCny = toCny(item.catalogPrompt, item.currency, fx.effectiveRate);
    const catalogCompletionCny = toCny(item.catalogCompletion, item.currency, fx.effectiveRate);
    const catalogCharged =
      Number(item.catalogPrompt) > 0 || Number(item.catalogCompletion) > 0;
    const weSellFree =
      ours != null && Number(ours.inputPrice) === 0 && Number(ours.outputPrice) === 0;

    let diff: CatalogDiffState = 'new';
    let driftPct: number | null = null;
    if (ours != null && catalogPromptCny != null && catalogCompletionCny != null && catalogCharged && !weSellFree) {
      const oursAvg = (Number(ours.inputPrice) + Number(ours.outputPrice)) / 2;
      const catalogAvg = (Number(catalogPromptCny) + Number(catalogCompletionCny)) / 2;
      if (oursAvg > 0) {
        const ratio = catalogAvg / oursAvg;
        driftPct = Math.round((ratio - 1) * 1000) / 10;
        diff = ratio > 1 + DRIFT_BAND ? 'price_up' : ratio < 1 - DRIFT_BAND ? 'price_down' : 'same';
      }
    } else if (ours != null) {
      diff = 'same';
    }
    return {
      ...item,
      imported: ours,
      diff,
      driftPct,
      isFree: !catalogCharged,
      priceWarning: catalogCharged && weSellFree,
    };
  });
}

/**
 * 上游消失检测：库内已有映射的 realModel 不在目录里 = 候选消失行
 * （调用方再按渠道绑定过滤——只对绑定到该源渠道的映射判消失，跨源同名不误伤）。
 */
export function goneFromCatalog(
  existing: ReadonlyArray<{ mappingId: number; externalName: string; realModel: string }>,
  catalogRealModels: ReadonlySet<string>,
): Array<{ mappingId: number; externalName: string; realModel: string }> {
  return existing.filter((e) => !catalogRealModels.has(e.realModel));
}
