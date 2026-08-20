/**
 * 目录路由（会话）：目录源清单 / 拉取比对 / 一键导入 / 厂商预设档案。
 * 导入价格必填（提交即确认——目录价只展示不自动带入；防 0 卖亏钱）。
 */
import { Hono } from 'hono';
import type { MiddlewareHandler } from 'hono';
import { z } from 'zod';
import { SUPPORTED_PROTOCOLS } from '@ai-gateway/ai';
import { adminCtxOf } from './ctx.js';
import { AppError } from '../http/error-map.js';
import type { CatalogService } from '../services/catalog.service.js';
import type { SessionEnv } from '../middleware/session.js';

const MONEY_MAX = 1e9;
const CONTEXT_LENGTH_MAX = 2_000_000_000;

const importModelSchema = z.object({
  externalName: z.string().min(1).max(64),
  realModel: z.string().min(1).max(128),
  inputPrice: z.coerce.number().min(0).finite().max(MONEY_MAX),
  outputPrice: z.coerce.number().min(0).finite().max(MONEY_MAX),
  cacheInputPrice: z.coerce.number().min(0).finite().max(MONEY_MAX),
  cacheWritePrice: z.coerce.number().min(0).finite().max(MONEY_MAX),
  contextLength: z.coerce.number().int().positive().finite().max(CONTEXT_LENGTH_MAX).nullable().optional(),
});

const importSchema = z.object({
  sourceId: z.string().min(1).max(32),
  apiKey: z.string().min(1).optional(),
  models: z.array(importModelSchema).min(1).max(200),
});

const sourceParam = (raw: string): string => {
  if (!/^[a-z0-9-]{1,32}$/.test(raw)) {
    throw new AppError(404, 'catalog_source_not_found', `未知的目录源：${raw}`);
  }
  return raw;
};

/** OpenAI 兼容厂商档案（创建 Provider 的 baseUrl 预设；全部走 openai-compatible 协议） */
export interface VendorProfile {
  key: string;
  name: string;
  baseUrl: string;
  note?: string;
}

export const VENDOR_CATALOG: readonly VendorProfile[] = [
  // ── 国际 ──
  { key: 'openai', name: 'OpenAI', baseUrl: 'https://api.openai.com/v1' },
  { key: 'openrouter', name: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1', note: '聚合 400+ 模型' },
  { key: 'groq', name: 'Groq', baseUrl: 'https://api.groq.com/openai/v1', note: '超低延迟推理' },
  { key: 'mistral', name: 'Mistral AI', baseUrl: 'https://api.mistral.ai/v1' },
  { key: 'deepseek', name: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1' },
  { key: 'xai', name: 'xAI (Grok)', baseUrl: 'https://api.x.ai/v1' },
  { key: 'perplexity', name: 'Perplexity', baseUrl: 'https://api.perplexity.ai' },
  { key: 'together', name: 'Together AI', baseUrl: 'https://api.together.xyz/v1' },
  { key: 'fireworks', name: 'Fireworks AI', baseUrl: 'https://api.fireworks.ai/inference/v1' },
  { key: 'cerebras', name: 'Cerebras', baseUrl: 'https://api.cerebras.ai/v1' },
  { key: 'sambanova', name: 'SambaNova', baseUrl: 'https://api.sambanova.ai/v1' },
  { key: 'nvidia', name: 'NVIDIA NIM', baseUrl: 'https://integrate.api.nvidia.com/v1' },
  { key: 'azure-foundry', name: 'Azure AI Foundry（OpenAI 兼容面）', baseUrl: 'https://YOUR-RESOURCE.openai.azure.com/openai/v1', note: '也可用 azure-openai 协议（部署制路径）' },
  { key: 'moonshot', name: 'Moonshot (Kimi)', baseUrl: 'https://api.moonshot.cn/v1' },
  { key: 'moonshot-intl', name: 'Moonshot 国际版', baseUrl: 'https://api.moonshot.ai/v1' },
  // ── 国内 ──
  { key: 'qwen', name: '阿里云百炼（通义千问）', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1' },
  { key: 'doubao', name: '火山方舟（豆包）', baseUrl: 'https://ark.cn-beijing.volces.com/api/v3', note: 'realModel 填推理接入点 ID（ep-xxx）或模型名' },
  { key: 'zhipu', name: '智谱 AI (GLM)', baseUrl: 'https://open.bigmodel.cn/api/paas/v4' },
  { key: 'minimax', name: 'MiniMax', baseUrl: 'https://api.minimax.chat/v1', note: 'tokensPerByte 校准已内置' },
  { key: 'minimax-intl', name: 'MiniMax 国际版', baseUrl: 'https://api.minimaxi.chat/v1' },
  { key: 'siliconflow', name: '硅基流动', baseUrl: 'https://api.siliconflow.cn/v1', note: '聚合国内开源模型 + 免费额度' },
  { key: 'baichuan', name: '百川', baseUrl: 'https://api.baichuan-ai.com/v1' },
  { key: 'stepfun', name: '阶跃星辰', baseUrl: 'https://api.stepfun.com/v1' },
  { key: 'lingyi', name: '零一万物', baseUrl: 'https://api.lingyiwanwu.com/v1' },
  { key: 'hunyuan', name: '腾讯混元（OpenAI 兼容）', baseUrl: 'https://api.hunyuan.cloud.tencent.com/v1' },
  { key: 'ernie', name: '百度千帆（OpenAI 兼容）', baseUrl: 'https://qianfan.baidubce.com/v2' },
  { key: 'xirang', name: '希壤/MaaS（火山）', baseUrl: 'https://maas-api.cn-wulanchabu.volces.com/api/v3' },
  { key: 'ai360', name: '360 智脑', baseUrl: 'https://api.360.cn/v1' },
  { key: 'modelscope', name: '魔搭 ModelScope', baseUrl: 'https://api-inference.modelscope.cn/v1' },
] as const;

export function catalogRoutes(service: CatalogService, session: MiddlewareHandler<SessionEnv>) {
  const app = new Hono<SessionEnv>();

  app.get('/v1/model-catalog/sources', session, (c) => c.json({ sources: service.listSources() }));

  /** 价格溯源：某对外名历次导入/改价的 provenance（目录价 × fx → 预填 → 提交）。
   *  注册在 :sourceId 之前——否则字面段被参数路由吞掉。 */
  app.get('/v1/model-catalog/price-history', session, async (c) => {
    const externalName = c.req.query('externalName');
    if (!externalName || externalName.length > 64) {
      throw new AppError(400, 'invalid_param', 'externalName 必填（≤64 字符）');
    }
    return c.json({ entries: await service.priceHistory(adminCtxOf(c), { externalName }) });
  });

  app.get('/v1/model-catalog/:sourceId', session, async (c) => {
    const sourceId = sourceParam(c.req.param('sourceId'));
    return c.json(await service.comparison(adminCtxOf(c), sourceId));
  });

  app.post('/v1/model-catalog/import', session, async (c) => {
    const body = importSchema.parse(await c.req.json());
    const result = await service.import(adminCtxOf(c), {
      adminId: c.get('adminId'),
      sourceId: body.sourceId,
      apiKey: body.apiKey,
      models: body.models.map((m) => ({
        externalName: m.externalName,
        realModel: m.realModel,
        inputPrice: String(m.inputPrice),
        outputPrice: String(m.outputPrice),
        cacheInputPrice: String(m.cacheInputPrice),
        cacheWritePrice: String(m.cacheWritePrice),
        contextLength: m.contextLength ?? null,
      })),
    });
    return c.json(result);
  });

  /** 厂商预设档案 + 协议词表（创建 Provider 表单的两个下拉单一真相） */
  app.get('/v1/vendor-catalog', session, (c) =>
    c.json({ protocols: SUPPORTED_PROTOCOLS, vendors: VENDOR_CATALOG }),
  );

  return app;
}
