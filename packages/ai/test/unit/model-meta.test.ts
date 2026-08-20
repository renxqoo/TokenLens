import { describe, expect, it } from 'vitest';
import { contextWindowOf } from '../../src/usage/model-meta.js';
import { detectSilentOverflow } from '../../src/errors/overflow.js';
import { tokenCountOf, TOKENIZE_MAX_CHARS } from '../../src/usage/tokenizer.js';
import { estimateInputTokens } from '../../src/usage/token-estimate.js';
import { VENDOR_PROFILES } from '../../src/registry/vendor-profiles.js';
import { createAi } from '../../src/create-ai.js';
import { defaultAiConfig } from '../../src/config.js';
import { startServer } from '../integration/helpers.js';
import { memoryDeps } from '../helpers/memory-deps.js';
import type { AiEvent } from '../../src/events.js';

/** models.dev 快照解析（A）+ 静默溢出（D）+ 分词器（B）+ 档案扩充（C）+ cache_write（E） */
describe('model-meta 解析（models.dev 快照）', () => {
  it('provider:model 精确键与裸模型名均可命中；未知 → null', () => {
    expect(contextWindowOf('openai', 'gpt-4o')).toBe(128_000);
    expect(contextWindowOf(undefined, 'gpt-4o')).toBeGreaterThan(0);
    expect(contextWindowOf('nobody', 'totally-unknown-model-xyz')).toBeNull();
    expect(contextWindowOf('openai')).toBeNull();
  });
});

describe('静默溢出判定（detectSilentOverflow）', () => {
  it('已知模型：超窗 true / 窗内 false；未知模型与非法输入 false', () => {
    expect(detectSilentOverflow(128_001, 'openai', 'gpt-4o')).toBe(true);
    expect(detectSilentOverflow(1_000, 'openai', 'gpt-4o')).toBe(false);
    expect(detectSilentOverflow(999_999_999, 'nobody', 'unknown-model')).toBe(false);
    expect(detectSilentOverflow(0, 'openai', 'gpt-4o')).toBe(false);
    expect(detectSilentOverflow(Number.NaN, 'openai', 'gpt-4o')).toBe(false);
  });

  it('经 createAi：mock usage 超窗 → success 事件带 contextOverflow 旗标（不翻转成功）', async () => {
    const upstream = await startServer((_q, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        id: 'c1', object: 'chat.completion',
        choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 999_999_999, completion_tokens: 1 },
      }));
    });
    try {
      const events: AiEvent[] = [];
      const ai = createAi({ ...defaultAiConfig(), allowLocalUrl: true }, { ...memoryDeps() });
      ai.onEvent((e) => events.push(e));
      const result = await ai.chat({
        channel: { baseUrl: upstream.baseUrl, apiKey: 'k', protocol: 'openai-compatible' },
        request: { model: 'ext', messages: [{ role: 'user', content: 'hi' }] },
        ctx: { requestId: 'so-1', model: 'gpt-4o', providerName: 'openai', endpoint: 'chat' },
      });
      expect(result.status).toBe('success');
      const success = events.find((e) => e.type === 'success');
      expect(success).toMatchObject({ type: 'success', contextOverflow: true });
    } finally {
      await upstream.close();
    }
  });
});

describe('BPE 分词器（js-tiktoken 主路径）', () => {
  // js-tiktoken 首次 getEncoding 要解析整张 rank 表——CI 慢机满载并行下可超 5s 默认值
  it('o200k 与 cl100k 对 CJK 编码不同（族解析正确性）；无模型/超长 → null 回落启发式', { timeout: 30_000 }, () => {
    const o = tokenCountOf('你好世界', 'gpt-4o');
    const c = tokenCountOf('你好世界', 'gpt-4');
    expect(o).not.toBeNull();
    expect(c).not.toBeNull();
    expect(o).not.toEqual(c); // o200k 对 CJK 更高效
    expect(tokenCountOf('你好世界')).toBeNull();
    expect(tokenCountOf('x'.repeat(TOKENIZE_MAX_CHARS + 1), 'gpt-4o')).toBeNull();
    expect(tokenCountOf('', 'gpt-4o')).toBeNull();
  });

  it('estimateInputTokens 带模型走精确路径（英文 tokenize ≈ 词数上界），无模型走启发式', { timeout: 30_000 }, () => {
    const withModel = estimateInputTokens(
      { messages: [{ role: 'user', content: 'hello world' }] },
      { model: 'gpt-4o' },
    );
    expect(withModel).toBeGreaterThan(0);
    const heur = estimateInputTokens({ messages: [{ role: 'user', content: 'hello world' }] });
    expect(heur).toBeGreaterThan(0);
  });
});

describe('vendor 档案扩充（pi-ai detectCompat 依据）', () => {
  it('七家档案齐备且规则形态只含 ignore/map', () => {
    expect(Object.keys(VENDOR_PROFILES).toSorted()).toEqual(
      ['deepseek', 'moonshot', 'nvidia', 'openai', 'together', 'xai', 'zai'].toSorted(),
    );
    for (const profile of Object.values(VENDOR_PROFILES)) {
      expect(Object.keys(profile.params).every((k) => k === 'ignore' || k === 'map')).toBe(true);
    }
  });

  it('deepseek 忽略 store/reasoning_effort；moonshot 把 max_completion_tokens 映射回 max_tokens', () => {
    expect(VENDOR_PROFILES['deepseek']?.params.ignore).toEqual(['store', 'reasoning_effort']);
    expect(VENDOR_PROFILES['moonshot']?.params.map).toEqual({ max_completion_tokens: { to: 'max_tokens' } });
  });
});

describe('cache_write 数据捕获（计费消费属独立资金工单）', () => {
  it('claude 非流式：cache_creation（含 1h 档）→ 规范形 usage.cache_write_tokens → Usage.cacheWriteTokens', async () => {
    const upstream = await startServer((_q, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-x', stop_reason: 'end_turn',
        content: [{ type: 'text', text: 'hi' }],
        usage: {
          input_tokens: 10, output_tokens: 3, cache_read_input_tokens: 4,
          cache_creation_input_tokens: 6, cache_creation: { ephemeral_1h_input_tokens: 2 },
        },
      }));
    });
    try {
      const events: AiEvent[] = [];
      const ai = createAi({ ...defaultAiConfig(), allowLocalUrl: true }, memoryDeps());
      ai.onEvent((e) => events.push(e));
      const result = await ai.chat({
        channel: { baseUrl: upstream.baseUrl, apiKey: 'k', protocol: 'anthropic' },
        request: { model: 'm', messages: [{ role: 'user', content: 'hi' }] },
        ctx: { requestId: 'cw-1', model: 'claude-x', providerName: 'anthropic', endpoint: 'chat' },
      });
      expect(result.status).toBe('success');
      // 总输入 = 10(未缓存) + 4(读) + 8(写) = 22；写 = 5m 档 6 + 1h 档 2
      if (result.status === 'success') {
        expect(result.usage).toMatchObject({ inputTokens: 22, cachedInputTokens: 4, outputTokens: 3, cacheWriteTokens: 8 });
      }
      const success = events.find((e) => e.type === 'success');
      expect(success).toMatchObject({ type: 'success' });
    } finally {
      await upstream.close();
    }
  });

  it('claude 流式：usage 帧携带 cache_write_tokens（scanner 归一进终态 usage）', async () => {
    const frames = [
      'data: {"type":"message_start","message":{"model":"claude-x","id":"m1","usage":{"input_tokens":7,"output_tokens":0,"cache_read_input_tokens":2,"cache_creation_input_tokens":5}}}',
      'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}',
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"ok"}}',
      'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":2}}',
      'data: {"type":"message_stop"}',
    ].join('\n\n');
    const upstream = await startServer((_q, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(frames);
    });
    try {
      const events: AiEvent[] = [];
      const ai = createAi({ ...defaultAiConfig(), allowLocalUrl: true }, memoryDeps());
      const handle = await ai.chatStream({
        channel: { baseUrl: upstream.baseUrl, apiKey: 'k', protocol: 'anthropic' },
        request: { model: 'm', messages: [{ role: 'user', content: 'hi' }], stream: true },
        ctx: { requestId: 'cw-2', model: 'claude-x', providerName: 'anthropic', endpoint: 'chat' },
      });
      handle.onEvent((e) => events.push(e));
      await new Response(handle.stream).text();
      const success = events.find((e) => e.type === 'success');
      expect(success).toMatchObject({
        type: 'success',
        usage: { inputTokens: 14, cachedInputTokens: 2, outputTokens: 2, cacheWriteTokens: 5 },
      });
    } finally {
      await upstream.close();
    }
  });

  it('normalize 方言：顶层 cache_write_tokens 归一', async () => {
    const { normalizeUsage } = await import('../../src/usage/normalize.js');
    expect(normalizeUsage({ prompt_tokens: 5, completion_tokens: 1, cache_write_tokens: 3 }))
      .toMatchObject({ inputTokens: 5, outputTokens: 1, cacheWriteTokens: 3 });
    expect(normalizeUsage({ prompt_tokens: 5, completion_tokens: 1 }))
      .not.toHaveProperty('cacheWriteTokens');
  });
});
