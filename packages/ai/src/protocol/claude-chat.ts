import { openaiDone, openaiFrame, sseToSseStream, type SseEvent } from './stream-convert';

/**
 * Claude Messages ⇄ OpenAI Chat 双向 codec（chat 家族，relaykit 等价物）。
 *
 * 规范形 = OpenAI chat/completions（请求/响应/流式 chunk）。本模块四个方向：
 *   ① claudeRequestToChat   入站 /v1/messages 请求 → 规范形请求
 *   ② chatRequestToClaude   规范形请求 → Claude /v1/messages 请求（anthropic 上游适配器用）
 *   ③ claudeResponseToChat  Claude 非流式响应 → 规范形响应
 *   ④ 流式：claudeUpstreamToCanonicalStream（上游→规范）/ canonicalStreamToClaudeStream（规范→客户端）
 *
 * usage 语义归一：cache_read_input_tokens → cachedInputTokens；
 * cache_creation_input_tokens 计入未缓存输入（发生写入成本，按 input 价计）。
 * max_tokens：Claude 必填——规范形缺省时用 DEFAULT_CLAUDE_MAX_TOKENS。
 */

export const DEFAULT_CLAUDE_MAX_TOKENS = 4096;

type Json = Record<string, unknown>;

function asJson(v: unknown): Json | null {
  return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Json) : null;
}
function asArray(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}
function str(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined;
}

// ─────────────────────────── 内容块映射 ───────────────────────────

/** chat message.content → claude content blocks */
function chatContentToClaude(content: unknown): unknown[] {
  if (typeof content === 'string') return content ? [{ type: 'text', text: content }] : [];
  return asArray(content).map((part) => {
    const p = asJson(part);
    if (!p) return { type: 'text', text: '' };
    if (p.type === 'text' && typeof p.text === 'string') return { type: 'text', text: p.text };
    if (p.type === 'image_url') {
      const url = str(asJson(p.image_url)?.url) ?? '';
      // data URL → base64 source；远程 URL 不转换（claude 支持 url source）
      const m = /^data:([^;,]+);base64,(.*)$/s.exec(url);
      if (m) return { type: 'image', source: { type: 'base64', media_type: m[1], data: m[2] } };
      return { type: 'image', source: { type: 'url', url } };
    }
    return { type: 'text', text: '' };
  });
}

/** claude content blocks → chat content（文本 join 为 string；含工具/图像时用块数组） */
function claudeContentToChat(blocks: unknown): string | Array<Record<string, unknown>> {
  const arr = asArray(blocks);
  const out: Array<Record<string, unknown>> = [];
  let textOnly = true;
  for (const b of arr) {
    const block = asJson(b);
    if (!block) continue;
    if (block.type === 'text' && typeof block.text === 'string') {
      out.push({ type: 'text', text: block.text });
    } else if (block.type === 'image' || block.type === 'tool_use' || block.type === 'tool_result' || block.type === 'thinking') {
      textOnly = false;
      // 复杂块保留原样（规范形 passthrough——OpenAI 形态无法表达的部分不强行降级）
      out.push(block as Record<string, unknown>);
    } else {
      textOnly = false;
    }
  }
  if (textOnly) return out.map((b) => (b as { text: string }).text).join('');
  return out;
}

// ─────────────────────────── ① 入站请求 → 规范形 ───────────────────────────

export function claudeRequestToChat(req: unknown): Json {
  const r = asJson(req) ?? {};
  const messages: unknown[] = [];
  // system（string 或 blocks）→ 首条 system message
  const system = str(r.system);
  if (system) messages.push({ role: 'system', content: system });
  else if (Array.isArray(r.system)) {
    const text = asArray(r.system)
      .map((b) => str(asJson(b)?.text) ?? '')
      .join('');
    if (text) messages.push({ role: 'system', content: text });
  }
  for (const m of asArray(r.messages)) {
    const msg = asJson(m);
    if (!msg) continue;
    const role = str(msg.role) === 'assistant' ? 'assistant' : str(msg.role) === 'user' ? 'user' : 'user';
    // 工具结果块（user 消息里的 tool_result）→ chat tool 消息
    const blocks = asArray(msg.content);
    const toolResults = blocks.filter((b) => asJson(b)?.type === 'tool_result');
    if (toolResults.length > 0) {
      for (const tr of toolResults) {
        const t = asJson(tr)!;
        messages.push({
          role: 'tool',
          tool_call_id: str(t.tool_use_id) ?? '',
          content: claudeContentToChat(t.content ?? str(t.content)),
        });
      }
      const rest = blocks.filter((b) => asJson(b)?.type !== 'tool_result');
      if (rest.length > 0) messages.push({ role, content: claudeContentToChat(rest) });
      continue;
    }
    // assistant 工具调用块 → chat tool_calls
    const toolUses = blocks.filter((b) => asJson(b)?.type === 'tool_use');
    const entry: Json = { role, content: claudeContentToChat(msg.content) };
    if (role === 'assistant' && toolUses.length > 0) {
      entry.tool_calls = toolUses.map((tu) => {
        const t = asJson(tu)!;
        return {
          id: str(t.id) ?? `call_${str(t.id) ?? 'x'}`,
          type: 'function',
          function: { name: str(t.name) ?? '', arguments: JSON.stringify(t.input ?? {}) },
        };
      });
    }
    messages.push(entry);
  }
  const out: Json = { model: str(r.model) ?? '', messages };
  if (typeof r.max_tokens === 'number') out.max_tokens = r.max_tokens;
  if (typeof r.temperature === 'number') out.temperature = r.temperature;
  if (typeof r.top_p === 'number') out.top_p = r.top_p;
  if (Array.isArray(r.stop_sequences)) out.stop = r.stop_sequences.map((s) => String(s));
  if (r.stream === true) out.stream = true;
  if (Array.isArray(r.tools)) {
    out.tools = r.tools
      .map((t) => {
        const tool = asJson(t);
        if (!tool) return null;
        return { type: 'function', function: { name: str(tool.name) ?? '', description: str(tool.description) ?? '', parameters: tool.input_schema ?? {} } };
      })
      .filter(Boolean);
  }
  const tc = asJson(r.tool_choice);
  if (tc) {
    if (tc.type === 'auto') out.tool_choice = 'auto';
    else if (tc.type === 'any') out.tool_choice = 'required';
    else if (tc.type === 'tool' && typeof tc.name === 'string') out.tool_choice = { type: 'function', function: { name: tc.name } };
  }
  return out;
}

// ─────────────────────────── ② 规范形请求 → Claude（上游适配器） ───────────────────────────

export function chatRequestToClaude(req: unknown): Json {
  const r = asJson(req) ?? {};
  const out: Json = {};
  const messages: unknown[] = [];
  let systemText = '';
  for (const m of asArray(r.messages)) {
    const msg = asJson(m);
    if (!msg) continue;
    const role = str(msg.role);
    if (role === 'system' || role === 'developer') {
      const c = msg.content;
      systemText += (systemText ? '\n' : '') + (typeof c === 'string' ? c : JSON.stringify(c));
      continue;
    }
    if (role === 'tool') {
      messages.push({
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: str(msg.tool_call_id) ?? '', content: typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content ?? '') },
        ],
      });
      continue;
    }
    if (role === 'assistant') {
      const blocks: unknown[] = typeof msg.content === 'string' && msg.content
        ? [{ type: 'text', text: msg.content }]
        : chatContentToClaude(msg.content);
      for (const tc of asArray(msg.tool_calls)) {
        const call = asJson(tc);
        const fn = asJson(call?.function);
        if (!call || !fn) continue;
        let input: unknown = {};
        try {
          input = JSON.parse(str(fn.arguments) ?? '{}');
        } catch {
          input = {};
        }
        blocks.push({ type: 'tool_use', id: str(call.id) ?? 'tool_u_x', name: str(fn.name) ?? '', input });
      }
      messages.push({ role: 'assistant', content: blocks });
      continue;
    }
    messages.push({ role: 'user', content: chatContentToClaude(msg.content) });
  }
  if (systemText) out.system = systemText;
  out.messages = messages;
  out.max_tokens =
    typeof r.max_tokens === 'number' && r.max_tokens > 0
      ? r.max_tokens
      : typeof r.max_completion_tokens === 'number' && r.max_completion_tokens > 0
        ? r.max_completion_tokens
        : DEFAULT_CLAUDE_MAX_TOKENS;
  if (typeof r.temperature === 'number') out.temperature = r.temperature;
  if (typeof r.top_p === 'number') out.top_p = r.top_p;
  if (Array.isArray(r.stop)) out.stop_sequences = r.stop.map((s) => String(s));
  if (Array.isArray(r.tools)) {
    out.tools = r.tools
      .map((t) => {
        const tool = asJson(t);
        const fn = asJson(tool?.function);
        if (!fn) return null;
        return { name: str(fn.name) ?? '', description: str(fn.description) ?? '', input_schema: fn.parameters ?? { type: 'object' } };
      })
      .filter(Boolean);
  }
  const tc = r.tool_choice;
  if (tc === 'auto') out.tool_choice = { type: 'auto' };
  else if (tc === 'required' || tc === 'any') out.tool_choice = { type: 'any' };
  else if (asJson(tc)?.type === 'function') {
    const fnName = str(asJson(asJson(tc)?.function)?.name);
    if (fnName) out.tool_choice = { type: 'tool', name: fnName };
  }
  if (r.stream === true) out.stream = true;
  return out;
}

// ─────────────────────────── ③ 非流式响应 → 规范形 ───────────────────────────

const STOP_REASON_MAP: Record<string, string> = {
  end_turn: 'stop',
  stop_sequence: 'stop',
  max_tokens: 'length',
  tool_use: 'tool_calls',
  refusal: 'content_filter',
};

export function claudeUsageToUsage(u: unknown): {
  /** 总输入（OpenAI 口径 = 未缓存 + 缓存读 + 缓存写；Anthropic input_tokens 只含未缓存） */
  promptTokens: number;
  completionTokens: number;
  cachedTokens: number;
  /** 缓存写入（5m + 1h 两档合计——1h 档在 cache_creation.ephemeral_1h_input_tokens） */
  cacheCreationTokens: number;
} | null {
  const j = asJson(u);
  if (!j) return null;
  const input = typeof j.input_tokens === 'number' ? j.input_tokens : NaN;
  const output = typeof j.output_tokens === 'number' ? j.output_tokens : NaN;
  if (!Number.isFinite(input) || !Number.isFinite(output)) return null;
  const cacheRead = typeof j.cache_read_input_tokens === 'number' ? j.cache_read_input_tokens : 0;
  const cacheCreate = typeof j.cache_creation_input_tokens === 'number' ? j.cache_creation_input_tokens : 0;
  const oneHour = asJson(j.cache_creation)?.ephemeral_1h_input_tokens;
  const cacheCreate1h = typeof oneHour === 'number' ? oneHour : 0;
  const write = cacheCreate + cacheCreate1h;
  // 口径修复（资金正确性）：Anthropic input_tokens 不含缓存部分——补齐为总输入，
  // 与规范形/计费公式的「inputTokens 含 cached（及 write）」口径对齐。
  // 历史缺陷：按旧口径 uncached = input − cached 会少算缓存命中的未缓存分量。
  const total = input + cacheRead + write;
  return {
    promptTokens: total,
    completionTokens: output,
    cachedTokens: Math.min(cacheRead, total),
    cacheCreationTokens: write,
  };
}

export function claudeResponseToChat(res: unknown): Json {
  const r = asJson(res) ?? {};
  const blocks = asArray(r.content);
  const textParts: string[] = [];
  const toolCalls: Array<Record<string, unknown>> = [];
  for (const b of blocks) {
    const block = asJson(b);
    if (!block) continue;
    if (block.type === 'text' && typeof block.text === 'string') textParts.push(block.text);
    if (block.type === 'tool_use') {
      toolCalls.push({
        id: str(block.id) ?? 'call_x',
        type: 'function',
        function: { name: str(block.name) ?? '', arguments: JSON.stringify(block.input ?? {}) },
      });
    }
  }
  const message: Json = { role: 'assistant', content: textParts.join('') };
  if (toolCalls.length > 0) message.tool_calls = toolCalls;
  const stopReason = str(r.stop_reason) ?? '';
  const usage = claudeUsageToUsage(r.usage);
  return {
    id: str(r.id) ?? 'chatcmpl-claude',
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: str(r.model) ?? '',
    choices: [
      {
        index: 0,
        message,
        finish_reason: STOP_REASON_MAP[stopReason] ?? (stopReason ? 'stop' : null),
      },
    ],
    ...(usage
      ? {
          usage: {
            prompt_tokens: usage.promptTokens,
            completion_tokens: usage.completionTokens,
            total_tokens: usage.promptTokens + usage.completionTokens,
            prompt_tokens_details: { cached_tokens: usage.cachedTokens },
            // 非标准扩展字段：缓存写入 token（OpenAI SDK 容忍未知子字段；消费方=本包 usage 归一）
            cache_write_tokens: usage.cacheCreationTokens,
          },
        }
      : {}),
  };
}

// ─────────────────────────── ④ 流式转换 ───────────────────────────

/**
 * Claude SSE 事件流 → 规范形 OpenAI chunk 流（上游侧）。
 * message_start → role 帧；content_block_delta(text_delta) → content delta；
 * content_block_delta(input_json_delta) → tool_calls delta；
 * message_delta(stop_reason/usage) → finish_reason 帧 + usage 帧；message_stop → [DONE]。
 */
export function claudeUpstreamToCanonicalStream(upstream: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> {
  let model = '';
  let id = 'chatcmpl-claude';
  let blockIndexToTool: Map<number, { index: number; id: string; name: string }> = new Map();
  let toolCallIndex = 0;
  let inputTokens = 0;
  let lastCompletionTokens: number | null = null;
  let cachedTokens = 0;
  let cacheWriteTokens = 0;
  let emitUsage = false;

  return sseToSseStream(
    upstream,
    (ev: SseEvent, emit) => {
      let data: Json;
      try {
        data = JSON.parse(ev.data) as Json;
      } catch {
        return;
      }
      if (data.type === 'message_start') {
        const msg = asJson(data.message) ?? {};
        model = str(msg.model) ?? model;
        id = str(msg.id) ?? id;
        const usage = claudeUsageToUsage(msg.usage);
        if (usage) {
          inputTokens = usage.promptTokens;
          cachedTokens = usage.cachedTokens;
          cacheWriteTokens = usage.cacheCreationTokens;
        }
        emit(openaiFrame({ id, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model, choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }] }));
        return;
      }
      if (data.type === 'content_block_start') {
        const idx = typeof data.index === 'number' ? data.index : 0;
        const block = asJson(data.content_block);
        if (block?.type === 'tool_use') {
          const slot = toolCallIndex++;
          blockIndexToTool.set(idx, { index: slot, id: str(block.id) ?? `call_${slot}`, name: str(block.name) ?? '' });
          emit(openaiFrame({ id, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model, choices: [{ index: 0, delta: { tool_calls: [{ index: slot, id: blockIndexToTool.get(idx)!.id, type: 'function', function: { name: blockIndexToTool.get(idx)!.name, arguments: '' } }] }, finish_reason: null }] }));
        }
        return;
      }
      if (data.type === 'content_block_delta') {
        const idx = typeof data.index === 'number' ? data.index : 0;
        const delta = asJson(data.delta) ?? {};
        if (delta.type === 'text_delta' && typeof delta.text === 'string') {
          emit(openaiFrame({ id, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model, choices: [{ index: 0, delta: { content: delta.text }, finish_reason: null }] }));
        } else if (delta.type === 'input_json_delta' && typeof delta.partial_json === 'string') {
          const tool = blockIndexToTool.get(idx);
          if (tool) {
            emit(openaiFrame({ id, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model, choices: [{ index: 0, delta: { tool_calls: [{ index: tool.index, function: { arguments: delta.partial_json } }] }, finish_reason: null }] }));
          }
        } else if (delta.type === 'thinking_delta' && typeof delta.thinking === 'string') {
          // 思考增量 → reasoning_content（DeepSeek 风格，规范形 passthrough 字段）
          emit(openaiFrame({ id, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model, choices: [{ index: 0, delta: { reasoning_content: delta.thinking }, finish_reason: null }] }));
        }
        return;
      }
      if (data.type === 'message_delta') {
        const delta = asJson(data.delta) ?? {};
        // Anthropic 语义：message_delta.usage 只带 output_tokens（input 侧在 message_start）——
        // 严格双字段解析会永远拒绝它（存量缺陷：流式 usage 因此从未发出，计费全走估算）。
        // 宽松读取：output 侧直接取；完整形态出现时才覆盖 input/缓存侧。
        const du = asJson(data.usage);
        if (du !== null && typeof du.output_tokens === 'number') {
          lastCompletionTokens = du.output_tokens;
        }
        const usage = du !== null ? claudeUsageToUsage(du) : null;
        if (usage) {
          inputTokens = usage.promptTokens;
          cachedTokens = usage.cachedTokens;
          cacheWriteTokens = usage.cacheCreationTokens;
        }
        const stopReason = str(delta.stop_reason);
        if (stopReason !== undefined) {
          emitUsage = true;
          emit(openaiFrame({
            id,
            object: 'chat.completion.chunk',
            created: Math.floor(Date.now() / 1000),
            model,
            choices: [{ index: 0, delta: {}, finish_reason: STOP_REASON_MAP[stopReason] ?? 'stop' }],
            ...(lastCompletionTokens !== null && inputTokens > 0
              ? {
                  usage: {
                    prompt_tokens: inputTokens,
                    completion_tokens: lastCompletionTokens,
                    total_tokens: inputTokens + lastCompletionTokens,
                    ...(cachedTokens > 0 ? { prompt_tokens_details: { cached_tokens: cachedTokens } } : {}),
                    ...(cacheWriteTokens > 0 ? { cache_write_tokens: cacheWriteTokens } : {}),
                  },
                }
              : {}),
          }));
        }
        return;
      }
      if (data.type === 'message_stop') {
        emit(openaiDone());
      }
      // error 事件：透传给规范形错误帧（relay scanner 识别 {error:...}）
      if (data.type === 'error') {
        const err = asJson(data.error) ?? {};
        emit(openaiFrame({ error: { code: str(err.type) ?? 'upstream_error', type: str(err.type), message: str(err.message) ?? 'claude stream error' } }));
        emit(openaiDone());
      }
    },
    (emit) => {
      // 兜底：上游没有 message_delta（异常断流）也保证 usage 帧与 [DONE] 尽力补齐
      if (emitUsage === false && inputTokens > 0 && lastCompletionTokens !== null) {
        emit(openaiFrame({
          id, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model,
          choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
          usage: {
            prompt_tokens: inputTokens,
            completion_tokens: lastCompletionTokens,
            total_tokens: inputTokens + lastCompletionTokens,
            ...(cachedTokens > 0 ? { prompt_tokens_details: { cached_tokens: cachedTokens } } : {}),
            ...(cacheWriteTokens > 0 ? { cache_write_tokens: cacheWriteTokens } : {}),
          },
        }));
      }
      emit(openaiDone());
    },
  );
}

/**
 * 规范形 OpenAI chunk 流 → Claude SSE 事件流（客户端侧，入站 /v1/messages 流式）。
 * 逐 chunk 合成 message_start / content_block_delta / message_delta / message_stop。
 */
export function canonicalStreamToClaudeStream(
  upstream: ReadableStream<Uint8Array>,
  model: string,
): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  const frame = (event: string, obj: Record<string, unknown>): Uint8Array =>
    enc.encode(`event: ${event}\ndata: ${JSON.stringify(obj)}\n\n`);
  let started = false;
  let textOpen = false;
  const tools: Map<number, { id: string; name: string; args: string }> = new Map();
  let inputTokens = 0;
  let outputTokens = 0;
  let cachedTokens = 0;
  let cacheWriteTokens = 0;
  let finishReason: string | null = null;
  let messageId = 'msg_' + Math.random().toString(36).slice(2, 14);


  return sseToSseStream(
    upstream,
    (ev: SseEvent, emit) => {
      if (ev.data === '[DONE]') {
        // [DONE] → message_delta(stop_reason) + message_stop
        if (!finishReason) finishReason = 'end_turn';
        emit(frame('message_delta', {
          type: 'message_delta',
          delta: { stop_reason: claudeStopOf(finishReason) ?? 'end_turn' },
          usage: {
            input_tokens: inputTokens,
            output_tokens: outputTokens,
            // 缓存字段还原为 claude 原生名（客户端 /v1/messages 面的保真）
            ...(cachedTokens > 0 ? { cache_read_input_tokens: cachedTokens } : {}),
            ...(cacheWriteTokens > 0 ? { cache_creation_input_tokens: cacheWriteTokens } : {}),
          },
        }));
        if (textOpen) emit(frame('content_block_stop', { type: 'content_block_stop', index: 0 }));
        for (const idx of tools.keys()) {
          emit(frame('content_block_stop', { type: 'content_block_stop', index: idx + 1 }));
        }
        emit(frame('message_stop', { type: 'message_stop' }));
        return;
      }
      let chunk: Json;
      try {
        chunk = JSON.parse(ev.data) as Json;
      } catch {
        return;
      }
      // 规范形错误帧（relay 注入/上游错误）→ claude error 事件
      if (chunk.error !== undefined) {
        const err = asJson(chunk.error) ?? {};
        emit(frame('error', { type: 'error', error: { type: str(err.type) ?? 'api_error', message: str(err.message) ?? 'stream error' } }));
        return;
      }
      const choice = asJson(asArray(chunk.choices)[0]);
      const delta = asJson(choice?.delta) ?? {};
      if (!started) {
        started = true;
        if (typeof chunk.id === 'string') messageId = chunk.id;
        emit(frame('message_start', { type: 'message_start', message: { id: messageId, type: 'message', role: 'assistant', model, content: [], stop_reason: null, usage: { input_tokens: 0, output_tokens: 0 } } }));
      }
      const usage = asJson(chunk.usage);
      if (usage) {
        inputTokens = typeof usage.prompt_tokens === 'number' ? usage.prompt_tokens : inputTokens;
        outputTokens = typeof usage.completion_tokens === 'number' ? usage.completion_tokens : outputTokens;
        const details = asJson(usage.prompt_tokens_details);
        if (details !== null && typeof details.cached_tokens === 'number') cachedTokens = details.cached_tokens;
        if (typeof usage.cache_write_tokens === 'number') cacheWriteTokens = usage.cache_write_tokens;
      }
      if (typeof delta.role === 'string' && !textOpen) {
        // role 帧 → 开文本块（claude 客户端兼容）
        textOpen = true;
        emit(frame('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }));
      }
      if (typeof delta.content === 'string' && delta.content.length > 0) {
        if (!textOpen) {
          textOpen = true;
          emit(frame('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }));
        }
        emit(frame('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: delta.content } }));
      }
      for (const tc of asArray(delta.tool_calls)) {
        const call = asJson(tc);
        if (!call) continue;
        const fn = asJson(call.function) ?? {};
        const slot = typeof call.index === 'number' ? call.index : 0;
        if (!tools.has(slot)) {
          tools.set(slot, { id: str(call.id) ?? `toolu_${slot}`, name: str(fn.name) ?? '', args: '' });
          emit(frame('content_block_start', { type: 'content_block_start', index: slot + 1, content_block: { type: 'tool_use', id: tools.get(slot)!.id, name: tools.get(slot)!.name, input: {} } }));
        }
        if (typeof fn.arguments === 'string' && fn.arguments.length > 0) {
          emit(frame('content_block_delta', { type: 'content_block_delta', index: slot + 1, delta: { type: 'input_json_delta', partial_json: fn.arguments } }));
        }
      }
      if (typeof choice?.finish_reason === 'string' && choice.finish_reason) {
        finishReason = choice.finish_reason;
      }
    },
    (emit) => {
      // 规范形流无 [DONE] 结束（异常）→ 补 message_stop 防客户端挂死
      if (started) {
        emit(frame('message_delta', { type: 'message_delta', delta: { stop_reason: claudeStopOf(finishReason) ?? 'end_turn' }, usage: { input_tokens: inputTokens, output_tokens: outputTokens } }));
        emit(frame('message_stop', { type: 'message_stop' }));
      }
    },
  );
}

// ─────────────────────── 客户端方向非流式：规范形 → Claude 响应 ───────────────────────

/** finish_reason → claude stop_reason（模块级纯函数） */
const claudeStopOf = (finish: string | null): string | null => {
  if (finish === 'length') return 'max_tokens';
  if (finish === 'tool_calls') return 'tool_use';
  if (finish === 'content_filter') return 'refusal';
  if (finish === 'stop' || finish === null) return finish === null ? null : 'end_turn';
  return 'end_turn';
};

const CHAT_FINISH_TO_CLAUDE: Record<string, string> = {
  stop: 'end_turn',
  length: 'max_tokens',
  tool_calls: 'tool_use',
  content_filter: 'refusal',
};

/** 规范形 chat 非流式响应 → Claude Messages 响应（入站 /v1/messages 非流式） */
export function chatResponseToClaude(res: unknown): Json {
  const r = asJson(res) ?? {};
  const choice = asJson(asArray(r.choices)[0]) ?? {};
  const message = asJson(choice.message) ?? {};
  const blocks: unknown[] = [];
  const content = typeof message.content === 'string' ? message.content : '';
  if (content) blocks.push({ type: 'text', text: content });
  for (const tc of asArray(message.tool_calls)) {
    const call = asJson(tc);
    const fn = asJson(call?.function);
    if (!call || !fn) continue;
    let input: unknown = {};
    try {
      input = JSON.parse(str(fn.arguments) ?? '{}');
    } catch {
      input = {};
    }
    blocks.push({ type: 'tool_use', id: str(call.id) ?? 'toolu_x', name: str(fn.name) ?? '', input });
  }
  const usage = asJson(r.usage);
  const inputTokens = typeof usage?.prompt_tokens === 'number' ? usage.prompt_tokens : 0;
  const outputTokens = typeof usage?.completion_tokens === 'number' ? usage.completion_tokens : 0;
  const cached = typeof (asJson(usage?.prompt_tokens_details) ?? {})?.cached_tokens === 'number'
    ? (asJson(usage?.prompt_tokens_details)!.cached_tokens as number)
    : 0;
  const finish = str(choice.finish_reason) ?? 'end_turn';
  return {
    id: str(r.id) ?? 'msg_gateway',
    type: 'message',
    role: 'assistant',
    model: str(r.model) ?? '',
    content: blocks,
    stop_reason: CHAT_FINISH_TO_CLAUDE[finish] ?? 'end_turn',
    stop_sequence: null,
    usage: { input_tokens: inputTokens, output_tokens: outputTokens, cache_read_input_tokens: cached },
  };
}
