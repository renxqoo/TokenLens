import { describe, expect, it } from 'vitest';
import { GeminiAdapter } from '../../src/adapters/gemini.js';
import { AwsBedrockAdapter } from '../../src/adapters/aws-bedrock.js';
import { AzureOpenAIAdapter } from '../../src/adapters/azure-openai.js';
import { OpenAICompatibleAdapter } from '../../src/adapters/openai-compatible.js';
import { defineAdapter } from '../../src/registry/define-adapter.js';
import { createRestTaskOps } from '../../src/adapters/task-kit.js';
import { createUpstreamError } from '../../src/errors/classify.js';
import { channelKey } from '../../src/pipeline/context.js';
import { joinUrl } from '../../src/join-url.js';
import { probeChannel } from '../../src/pipeline/probe.js';
import { startServer } from '../integration/helpers.js';
import { defaultAiConfig } from '../../src/config.js';

/** 适配器/机制链边角分支矩阵（每个用例对应一处未覆盖分支） */
const enc = (s: string) => new TextEncoder().encode(s);
const emptyStream = () => new ReadableStream<Uint8Array>({ start: (c) => c.close() });

describe('openai-compatible 抹平引擎边角', () => {
  const adapter = new OpenAICompatibleAdapter();
  it('非对象请求体透传底线；clamp 非数值跳过；min 分支生效', () => {
    expect(adapter.normalizeRequest('raw-string', {})).toEqual({ body: 'raw-string', adjustments: [] });
    const out = adapter.normalizeRequest(
      { model: 'm', top_p: 0.5, n: 1 },
      { clamp: { top_p: { min: 1, max: 2 }, n: { max: 4 } } },
    );
    expect(out.body).toEqual({ model: 'm', top_p: 1, n: 1 });
    expect(out.adjustments).toEqual([{ param: 'top_p', action: 'clamp', from: 0.5, to: 1 }]);
  });

  it('map 目标命中原型键防护跳过；unknown drop 时 map 目标名视为已知', () => {
    const out = adapter.normalizeRequest(
      { model: 'm', evil: 1, renamed: 2, strange: 3 },
      { map: { evil: { to: '__proto__' }, renamed: { to: 'known_x' } }, unknown: 'drop' },
    );
    // evil 被原型键防护跳过后仍属未知 → drop；renamed 映射到 known_x 保留；strange 未知 → drop
    expect(out.body).toEqual({ model: 'm', known_x: 2 });
  });
});

describe('gemini / bedrock / azure 适配器分支', () => {
  it('gemini：embeddings 寻址、translate 委托、canonical usage 无缓存明细分支、mapError 归一', async () => {
    const adapter = new GeminiAdapter();
    const channel = { baseUrl: 'https://g.test', apiKey: 'k', protocol: 'gemini' };
    expect(adapter.planRequest(channel, { endpoint: 'embeddings', model: 'm', requestId: 'r', stream: false }).path)
      .toContain('models/m:generateContent');
    expect(adapter.translateResponseBody({ candidates: [] })).toBeDefined();
    const translated = await new Response(adapter.translateUpstreamStream(emptyStream(), 'm')).text();
    expect(translated).toContain('[DONE]');
    // canonical usage 无 prompt_tokens_details → cached 0
    expect(adapter.extractUsage({ usage: { prompt_tokens: 3, completion_tokens: 1 } }))
      .toMatchObject({ inputTokens: 3, cachedInputTokens: 0, outputTokens: 1 });
    // mapError：401 → invalid_api_key+死凭据；status 文本归一 429/NOT_FOUND
    expect(adapter.mapError(401, {})).toMatchObject({ code: 'invalid_api_key', deadCredential: true });
    expect(adapter.mapError(500, { status: 'RESOURCE_EXHAUSTED' }).code).toBe('rate_limited');
    expect(adapter.mapError(500, { status: 'NOT_FOUND' }).code).toBe('model_not_found');
    expect(adapter.mapError(500, {}).code).toBe('upstream_error');
  });

  it('bedrock：寻址 invoke/stream、finalize 注入 anthropic_version+stream、usage、probe', async () => {
    const adapter = new AwsBedrockAdapter();
    const channel = { baseUrl: 'https://bedrock.test', apiKey: 'k', protocol: 'aws-bedrock' };
    expect(adapter.planRequest(channel, { endpoint: 'chat', model: 'anthropic.claude-x', requestId: 'r', stream: false }).path)
      .toBe('/model/anthropic.claude-x/invoke');
    expect(adapter.planRequest(channel, { endpoint: 'chat', model: 'm', requestId: 'r', stream: true }).path)
      .toBe('/model/m/invoke-with-response-stream');
    const nonStream = adapter.finalizeRequestBody({ model: 'ext', messages: [{ role: 'user', content: 'hi' }] }, { endpoint: 'chat', model: 'real', stream: false });
    expect(nonStream).toMatchObject({ anthropic_version: 'bedrock-2023-05-31' });
    expect((nonStream as { messages: Array<{ role: string; content: unknown }> }).messages).toEqual([{ role: 'user', content: [{ type: 'text', text: 'hi' }] }]);
    const stream = adapter.finalizeRequestBody({ model: 'ext', messages: [] }, { endpoint: 'chat', model: 'real', stream: true });
    expect(stream.stream).toBe(true);
    expect(adapter.normalizeRequest({ a: 1 }, {})).toEqual({ body: { a: 1 }, adjustments: [] });
    expect(adapter.translateResponseBody({ content: [] })).toBeDefined();
    await expect(new Response(adapter.translateUpstreamStream(emptyStream())).text()).resolves.toContain('[DONE]');
    expect(adapter.extractUsage({ usage: { input_tokens: 4, output_tokens: 2, cache_read_input_tokens: 1 } }))
      .toMatchObject({ inputTokens: 5, cachedInputTokens: 1, outputTokens: 2 }); // 总输入 4+1
    expect(adapter.extractUsage({})).toBeNull();
    expect(adapter.probeRequests(channel)).toEqual([{ path: '/models', headers: {} }]);
  });

  it('azure：embeddings 部署制寻址分支', () => {
    const plan = AzureOpenAIAdapter.planRequest(
      { baseUrl: 'https://x.openai.azure.com', apiKey: 'k', protocol: 'azure-openai' },
      { endpoint: 'embeddings', model: 'deploy-e', requestId: 'r', stream: false },
    );
    expect(plan.path).toBe(`/openai/deployments/deploy-e/embeddings?api-version=2024-10-21`);
  });
});

describe('机制链边角：channelKey 非法 URL / joinUrl 大小写 / probe 优先级', () => {
  it('channelKey：非法 baseUrl → protocol://unknown', () => {
    expect(channelKey({ baseUrl: 'not a url', apiKey: 'k', protocol: 'p' })).toBe('p://unknown');
  });

  it('joinUrl：版本段大小写不敏感去重', () => {
    expect(joinUrl('https://h.test/V1', '/v1/chat')).toBe('https://h.test/V1/chat');
  });

  it('probe：先 500 后 401 → 死凭据优先于普通错误；网络错误归一；空探测表=通过', async () => {
    const upstream = await startServer((req, res) => {
      if (req.url?.includes('/p500')) {
        res.writeHead(500).end('{}');
        return;
      }
      res.writeHead(401).end('{}');
    });
    try {
      const adapter = defineAdapter({
        protocol: 't-probe',
        addressing: {
          probeRequests: () => [
            { path: '/p500', headers: {} },
            { path: '/p401', headers: {} },
          ],
        },
      });
      const result = await probeChannel({
        channel: { baseUrl: upstream.baseUrl, apiKey: 'k', protocol: 't-probe' },
        adapter,
        cfg: { ...defaultAiConfig(), allowLocalUrl: true },
      });
      expect(result.ok).toBe(false);
      expect(result.error?.code).toBe('invalid_api_key');

      const unreachable = await probeChannel({
        channel: { baseUrl: 'http://127.0.0.1:1', apiKey: 'k', protocol: 't-probe' },
        adapter,
        cfg: { ...defaultAiConfig(), allowLocalUrl: true },
      });
      expect(unreachable.error?.code).toBe('network');

      const empty = defineAdapter({ protocol: 't-empty', addressing: { probeRequests: () => [] } });
      await expect(probeChannel({
        channel: { baseUrl: 'https://x.test', apiKey: 'k', protocol: 't-empty' },
        adapter: empty,
        cfg: defaultAiConfig(),
      })).resolves.toEqual({ ok: true, durationMs: expect.any(Number) });
    } finally {
      await upstream.close();
    }
  });
});

describe('task-kit 错误路径（信封/缺字段/坏形状）', () => {
  const cfg = {
    paths: {
      submit: '/s',
      query: (id: string) => `/q/${id}`,
      file: (id: string) => `/f/${id}`,
    },
    envelopeError: (body: unknown) => {
      const code = (body as { base_resp?: { status_code: number } } | null)?.base_resp?.status_code;
      return typeof code === 'number' && code !== 0
        ? createUpstreamError({ code: 'upstream_error', message: `env ${code}`, retryable: false, circuitTrip: false })
        : null;
    },
    invalidBodyError: () => createUpstreamError({ code: 'invalid_response', message: 'bad', retryable: false, circuitTrip: false }),
    extractSubmissionTaskId: (b: Record<string, unknown>) => (typeof b.task_id === 'string' ? b.task_id : undefined),
    extractCompletedArtifact: (b: Record<string, unknown>) => {
      const url = (b.data as { url?: string } | undefined)?.url;
      return typeof url === 'string' ? { url } : undefined;
    },
    readStatus: (b: Record<string, unknown>) => (b.status === 'ok' ? { status: 'succeeded' as const } : { status: 'running' as const }),
    extractFileUrl: (b: Record<string, unknown>) => (typeof b.url === 'string' ? b.url : undefined),
  };
  const ops = createRestTaskOps(cfg);

  it('parseResponse：信封错误优先；video 缺 task_id / music 缺产物 → invalid_response', () => {
    expect(ops.parseResponse('video', { base_resp: { status_code: 1 } })).toMatchObject({ kind: 'error', error: { code: 'upstream_error' } });
    expect(ops.parseResponse('video', {})).toMatchObject({ kind: 'error', error: { code: 'invalid_response' } });
    expect(ops.parseResponse('music', {})).toMatchObject({ kind: 'error', error: { code: 'invalid_response' } });
    expect(ops.parseResponse('video', null)).toMatchObject({ kind: 'error' });
  });

  it('parseTaskStatus：信封错误 / 坏形状 / running 兜底', () => {
    expect(ops.parseTaskStatus({ base_resp: { status_code: 1 } })).toMatchObject({ ok: false });
    expect(ops.parseTaskStatus(null)).toMatchObject({ ok: false, error: { code: 'invalid_response' } });
    expect(ops.parseTaskStatus({ status: 'pending' })).toEqual({ ok: true, status: 'running' });
  });

  it('parseFileRetrieve：信封错误 / 缺 url / 坏形状 → invalid_response', () => {
    expect(ops.parseFileRetrieve({ base_resp: { status_code: 1 } })).toMatchObject({ ok: false });
    expect(ops.parseFileRetrieve({})).toMatchObject({ ok: false, error: { code: 'invalid_response' } });
    expect(ops.parseFileRetrieve(null)).toMatchObject({ ok: false, error: { code: 'invalid_response' } });
  });

  it('planTaskQuery/planFileRetrieve 寻址带编码', () => {
    expect(ops.planTaskQuery({ baseUrl: 'https://x', apiKey: 'k', protocol: 'p' }, 'a b').path).toBe('/q/a%20b');
    expect(ops.planFileRetrieve({ baseUrl: 'https://x', apiKey: 'k', protocol: 'p' }, 'c').path).toBe('/f/c');
  });
});

describe('defineAdapter 边角：signRequest 透传 + 双 codec 件', () => {
  it('signRequest/translateUpstreamStream 件挂载并可调用', async () => {
    const adapter = defineAdapter({
      protocol: 't-full',
      addressing: {
        signRequest: () => ({ 'x-signature': 'sig' }),
      },
      codec: {
        translateResponseBody: (b) => ({ wrapped: b }),
        translateUpstreamStream: (s) => s,
      },
    });
    expect(await adapter.signRequest!({ url: new URL('https://x'), body: '', apiKey: 'k', amzDate: new Date() }))
      .toEqual({ 'x-signature': 'sig' });
    expect(adapter.translateResponseBody?.({ a: 1 })).toEqual({ wrapped: { a: 1 } });
    const passthrough = adapter.translateUpstreamStream!(new ReadableStream<Uint8Array>({ start: (c) => { c.enqueue(enc('x')); c.close(); } }), 'm');
    await expect(new Response(passthrough).text()).resolves.toBe('x');
  });
});
