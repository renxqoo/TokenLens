import { describe, expect, it } from 'vitest';
import {
  claudeRequestToChat,
  chatRequestToClaude,
  claudeResponseToChat,
  claudeUpstreamToCanonicalStream,
  canonicalStreamToClaudeStream,
  claudeUsageToUsage,
} from '../../src/protocol/claude-chat';

/** 官方风格 fixture（docs.api-reference 风格载荷） */
const CLAUDE_REQUEST = {
  model: 'claude-sonnet-4-5',
  max_tokens: 1024,
  system: 'Be concise.',
  messages: [
    { role: 'user', content: [{ type: 'text', text: 'Hello' }] },
    {
      role: 'assistant',
      content: [
        { type: 'text', text: 'Sure' },
        { type: 'tool_use', id: 'toolu_01', name: 'get_weather', input: { city: 'SF' } },
      ],
    },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_01', content: '18°C' }] },
  ],
  tools: [{ name: 'get_weather', description: 'weather', input_schema: { type: 'object', properties: { city: { type: 'string' } } } }],
  stream: true,
};

const CLAUDE_RESPONSE = {
  id: 'msg_01XFDUDYJgAACzvnptvVoYEL',
  type: 'message',
  role: 'assistant',
  model: 'claude-sonnet-4-5',
  content: [
    { type: 'text', text: 'Hi ' },
    { type: 'tool_use', id: 'toolu_02', name: 'get_weather', input: { city: 'NYC' } },
  ],
  stop_reason: 'tool_use',
  usage: { input_tokens: 25, output_tokens: 150, cache_read_input_tokens: 10, cache_creation_input_tokens: 5 },
};

async function streamToString(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  const dec = new TextDecoder();
  let out = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return out;
    out += dec.decode(value, { stream: true });
  }
}

describe('claude ⇄ chat codec', () => {
  it('① 入站请求 → 规范形：system/tool_use/tool_result 全链路映射', () => {
    const chat = claudeRequestToChat(CLAUDE_REQUEST) as Record<string, any>;
    expect(chat.messages).toHaveLength(4);
    expect(chat.messages[0]).toEqual({ role: 'system', content: 'Be concise.' });
    expect(chat.messages[2].tool_calls).toEqual([
      { id: 'toolu_01', type: 'function', function: { name: 'get_weather', arguments: '{"city":"SF"}' } },
    ]);
    expect(chat.messages[3].role).toBe('tool');
    expect(chat.messages[3].tool_call_id).toBe('toolu_01');
    expect(chat.tools[0].function.name).toBe('get_weather');
    expect(chat.max_tokens).toBe(1024);
    expect(chat.stream).toBe(true);
  });

  it('② 规范形 → claude（上游方向）：system 提取、tool 消息还原 tool_result、max_tokens 必填默认', () => {
    const chat = claudeRequestToChat(CLAUDE_REQUEST);
    delete (chat as Record<string, unknown>).max_tokens;
    const back = chatRequestToClaude(chat) as Record<string, any>;
    expect(back.system).toBe('Be concise.');
    expect(back.max_tokens).toBe(4096);
    const toolResultMsg = back.messages.find((m: any) =>
      Array.isArray(m.content) && m.content.some((b: any) => b.type === 'tool_result'),
    );
    expect(toolResultMsg.content[0].tool_use_id).toBe('toolu_01');
    const assistant = back.messages.find((m: any) => m.role === 'assistant');
    expect(assistant.content.some((b: any) => b.type === 'tool_use' && b.name === 'get_weather')).toBe(true);
    expect(back.tools[0].input_schema.type).toBe('object');
  });

  it('③ 非流式响应 → 规范形：text+tool_calls 合成、stop_reason=tool_use→tool_calls、cache usage 归一', () => {
    const chat = claudeResponseToChat(CLAUDE_RESPONSE) as Record<string, any>;
    expect(chat.object).toBe('chat.completion');
    expect(chat.choices[0].message.content).toBe('Hi ');
    expect(chat.choices[0].message.tool_calls[0].function.name).toBe('get_weather');
    expect(chat.choices[0].finish_reason).toBe('tool_calls');
    expect(chat.usage.prompt_tokens).toBe(40);
    expect(chat.usage.prompt_tokens).toBe(40);
    expect(chat.usage.completion_tokens).toBe(150);
    expect(chat.usage.prompt_tokens_details.cached_tokens).toBe(10);
    expect(claudeUsageToUsage(CLAUDE_RESPONSE.usage)).toEqual({
      promptTokens: 40, // 总输入 = 25(未缓存) + 10(读) + 5(写)——OpenAI 口径补齐
      completionTokens: 150,
      cachedTokens: 10,
      cacheCreationTokens: 5,
    });
  });

  it('④ 上游事件流 → 规范形 chunk 流：role/delta/finish/usage/[DONE]', async () => {
    const upstream = new ReadableStream<Uint8Array>({
      start(c) {
        const enc = new TextEncoder();
        const ev = (event: string, obj: unknown) =>
          c.enqueue(enc.encode(`event: ${event}\ndata: ${JSON.stringify(obj)}\n\n`));
        ev('message_start', { type: 'message_start', message: { id: 'msg_1', model: 'claude-sonnet-4-5', usage: { input_tokens: 25, output_tokens: 1 } } });
        ev('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
        ev('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hi' } });
        ev('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: ' there' } });
        ev('content_block_stop', { type: 'content_block_stop', index: 0 });
        ev('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { input_tokens: 25, output_tokens: 7 } });
        ev('message_stop', { type: 'message_stop' });
        c.close();
      },
    });
    const out = await streamToString(claudeUpstreamToCanonicalStream(upstream));
    const lines = out.split('\n\n').filter((l) => l.startsWith('data: ') && !l.includes('[DONE]'));
    const frames = lines.map((l) => JSON.parse(l.slice(6)));
    expect(frames.some((f: any) => f.choices?.[0]?.delta?.role === 'assistant')).toBe(true);
    expect(frames.filter((f: any) => typeof f.choices?.[0]?.delta?.content === 'string').map((f: any) => f.choices[0].delta.content).join('')).toBe('Hi there');
    expect(frames.some((f: any) => f.choices?.[0]?.finish_reason === 'stop')).toBe(true);
    const usageFrame = frames.find((f: any) => f.usage);
    expect(usageFrame.usage.prompt_tokens).toBe(25);
    expect(usageFrame.usage.completion_tokens).toBe(7);
    expect(out.trimEnd().endsWith('data: [DONE]')).toBe(true);
  });

  it('⑤ 规范形 chunk 流 → claude 事件流（客户端方向）：完整事件序列与 usage 汇总', async () => {
    const enc = new TextEncoder();
    const upstream = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(enc.encode(`data: ${JSON.stringify({ id: 'cmpl-1', object: 'chat.completion.chunk', model: 'x', choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }] })}\n\n`));
        c.enqueue(enc.encode(`data: ${JSON.stringify({ id: 'cmpl-1', object: 'chat.completion.chunk', model: 'x', choices: [{ index: 0, delta: { content: 'He' }, finish_reason: null }] })}\n\n`));
        c.enqueue(enc.encode(`data: ${JSON.stringify({ id: 'cmpl-1', object: 'chat.completion.chunk', model: 'x', choices: [{ index: 0, delta: { content: 'y' }, finish_reason: null }] })}\n\n`));
        c.enqueue(enc.encode(`data: ${JSON.stringify({ id: 'cmpl-1', object: 'chat.completion.chunk', model: 'x', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 } })}\n\n`));
        c.enqueue(enc.encode('data: [DONE]\n\n'));
        c.close();
      },
    });
    const out = await streamToString(canonicalStreamToClaudeStream(upstream, 'claude-sonnet-4-5'));
    expect(out).toContain('event: message_start');
    expect(out).toContain('"type":"text_delta","text":"He"');
    expect(out).toContain('"type":"text_delta","text":"y"');
    expect(out).toContain('event: content_block_stop');
    expect(out).toContain('event: message_delta');
    expect(out).toContain('"stop_reason":"end_turn"');
    expect(out).toContain('"input_tokens":10,"output_tokens":2');
    expect(out).toContain('event: message_stop');
    const order = [
      out.indexOf('event: message_start'),
      out.indexOf('event: content_block_start'),
      out.indexOf('event: content_block_delta'),
      out.indexOf('event: message_delta'),
      out.indexOf('event: message_stop'),
    ];
    expect([...order].toSorted((a, b) => a - b)).toEqual(order);
    expect(order.every((i) => i >= 0)).toBe(true);
  });
});
