/**
 * createAi 装配壳（机制链拆解后的编排根，行为语义见 docs/ai-package.md §5/§6）：
 *   - 注册表：协议适配器（注册即扩展；同键重复启动即抛）
 *   - 机制链：pipeline/prepare（参数抹平+准入对象）→ pipeline/chat|chat-stream
 *     （单次尝试体，withRetry 包裹）→ pipeline/stream-report（流式终态翻译）
 *   - 单渠道内重试（withRetry）；换渠道/fallback 模型候选循环是 gateway 的职责
 *   - 熔断按 channelKey（protocol://host）维度，计数只收 circuitTrip=true
 *   - 失败路径双向收敛：非流式返回 ChatResult；流式「流开始前失败」→ 返回含错误帧的流 + failed 事件
 */
import { OpenAICompatibleAdapter } from './adapters/openai-compatible';
import { AnthropicAdapter } from './adapters/anthropic';
import { GeminiAdapter } from './adapters/gemini';
import { AzureOpenAIAdapter } from './adapters/azure-openai';
import { AwsBedrockAdapter } from './adapters/aws-bedrock';
import { VertexAiAdapter } from './adapters/vertex-ai';
import { MiniMaxAdapter } from './adapters/minimax';
import type { ProtocolAdapter, UpstreamRequestPlan } from './adapters/protocol-adapter';
import { unsupportedProtocolError } from './errors/internal';
import { detectSilentOverflow } from './errors/overflow';
import { asRecord } from './internal/util';
import { relayStream } from './transport/relay-stream';
import { withRetry } from './retry/with-retry';
import { joinUrl } from './join-url';
import { admitRequest } from './pipeline/admission';
import { assertChannel, emitTo, fireAndForget, retryOptionsOf } from './pipeline/context';
import { createPrepare } from './pipeline/prepare';
import { createChatAttempt } from './pipeline/chat';
import { createStreamAttempt } from './pipeline/chat-stream';
import { attachRelayReporting, createStreamEventBus, failEarlyStream } from './pipeline/stream-report';
import { probeChannel } from './pipeline/probe';
import {
  makeParseGenerationResponse,
  makeQueryGenerationTask,
  makeRetrieveGenerationFile,
} from './pipeline/generation-ops';
import {
  type AiConfig,
  aiConfigSchema,
  type AiConfigInput,
  type AiDeps,
  type AiOptions,
  type BreakerStorage,
  type DeadCredentialStorage,
} from './config';
import type { AiEvent } from './events';
import type { Ai, ChannelDesc, RequestCtx, UpstreamError } from './types';

const noop = (): void => {};

/**
 * 默认协议注册表（不注入 adapters 时的注册项）。
 * 七个协议族：openai-compatible（含全部 OpenAI 兼容厂商）+ 五个原生协议
 * + minimax（任务族 video/music + MiniMax chat 兼容）。
 */
const defaultAdapters: ProtocolAdapter[] = [
  new OpenAICompatibleAdapter(),
  new AnthropicAdapter(),
  new GeminiAdapter(),
  AzureOpenAIAdapter,
  new AwsBedrockAdapter(),
  new VertexAiAdapter(),
  new MiniMaxAdapter(),
];

/** 默认注册表键——协议词表的单一真相（admin 配置面校验引用此处，不再各自枚举） */
export const SUPPORTED_PROTOCOLS: readonly string[] = defaultAdapters.map((a) => a.protocol);

/** 寻址 + 请求体终改前置的寻址件（chat/chatStream 共用；编排层零协议字面量） */
function planUpstream(
  adapter: ProtocolAdapter,
  channel: ChannelDesc,
  ctx: Pick<RequestCtx, 'model' | 'requestId' | 'endpoint'>,
  stream: boolean,
): { plan: UpstreamRequestPlan; url: string } {
  const plan = adapter.planRequest(channel, {
    endpoint: ctx.endpoint,
    model: ctx.model,
    requestId: ctx.requestId,
    stream,
  });
  return { plan, url: joinUrl(channel.baseUrl, plan.path) };
}

export function createAi(config: AiConfigInput, deps: AiDeps, options?: AiOptions): Ai {
  const cfg: AiConfig = aiConfigSchema.parse(config ?? {});
  const breakerStorage: BreakerStorage = deps.breakerStorage;
  const deadCredentialStorage: DeadCredentialStorage = deps.deadCredentialStorage;
  const log = deps?.logger ?? { info: noop, warn: noop, error: noop };

  // 全局事件总线（chat + chatStream 共用；gateway 订阅用于计量/排障/候选循环）
  const listeners: Array<(e: AiEvent) => void> = [];
  const emit = (e: AiEvent): void => emitTo(listeners, e);

  // 协议注册表（注册即扩展）：默认注册表；传入则整体替换（显式优先）。
  // 同键重复注册启动即抛——一个协议两个实现 = 双真相，必须在结构上杜绝。
  const adapters = new Map<string, ProtocolAdapter>();
  for (const adapter of options?.adapters ?? defaultAdapters) {
    if (adapters.has(adapter.protocol)) {
      throw new Error(`duplicate protocol adapter registration: ${adapter.protocol}`);
    }
    adapters.set(adapter.protocol, adapter);
  }
  // 未知协议显式报错（不静默回退 openai-compatible——配置错误必须可发现）
  const resolveAdapter = (channel: ChannelDesc): ProtocolAdapter | UpstreamError =>
    adapters.get(channel.protocol) ??
    unsupportedProtocolError(channel.protocol, [...adapters.keys()]);

  const prepare = createPrepare({
    cfg,
    breakerStorage,
    deadCredentialStorage,
    resolveAdapter,
    log,
    emit,
  });

  const generationDeps = { cfg, resolveAdapter, supportedProtocols: [...adapters.keys()] };

  return {
    async chat(input) {
      const start = Date.now();
      const prepared = prepare(input);
      if (!prepared.ok) {
        // prepare 目前恒 ok（normalizeRequest 不抛），保留分支防御
        return { status: 'error', error: prepared.error, durationMs: Date.now() - start };
      }
      const { body, breaker, credential, adapter, key } = prepared;
      const { requestId, endpoint } = input.ctx;

      const refused = await admitRequest({ breaker, credential, requestId, key, log });
      if (refused) {
        emit({ type: 'failed', requestId, channelKey: key, error: refused });
        return { status: 'error', error: refused, durationMs: Date.now() - start };
      }

      const { plan, url } = planUpstream(adapter, input.channel, input.ctx, false);
      const rec = asRecord(body);
      // multipart 包装契约：路由把重组的完整上游 FormData 放在 body.upstreamForm
      // （计量字段 model/audioSeconds 等留在 wrapper，不进上游）。此处拆包直传——
      // 历史缺陷：曾直接 JSON.stringify(wrapper)，FormData 字段序列化为 {}，
      // 文件字节静默丢失（mock 上游不校验 body 形状，测试拦不住）。
      const wrappedForm =
        rec !== null && rec.upstreamForm instanceof FormData ? (rec.upstreamForm as FormData) : null;
      if (wrappedForm !== null && wrappedForm.has('model')) {
        wrappedForm.set('model', input.ctx.model); // 对外名 → 真实名（与 JSON 路径同语义）
      }
      const finalBody = wrappedForm ?? (rec ? adapter.finalizeRequestBody(rec, { endpoint, model: input.ctx.model, stream: false }) : body);
      const { outcome, attempts } = await withRetry(
        createChatAttempt({
          channel: input.channel, ctx: input.ctx, url, plan, finalBody,
          adapter, breaker, credential, cfg, log, emit, key,
        }),
        retryOptionsOf(cfg, input.ctx),
        (info) =>
          log.warn(`[ai] ${requestId} retry attempt=${info.attempt} delay=${info.delayMs}`, {
            code: info.error.code,
          }),
      );

      const durationMs = Date.now() - start;
      if (outcome.ok) {
        await breaker.recordSuccess();
        await credential.recordSuccess();
        log.info(`[ai] ${requestId} success attempts=${attempts} usage=`, outcome.value.usage);
        // 静默溢出可观测：usage 输入超窗（供应商静默截断的信号，不翻转成功语义）
        const contextOverflow = outcome.value.usage
          ? detectSilentOverflow(outcome.value.usage.inputTokens, input.ctx.providerName, input.ctx.model)
          : false;
        if (contextOverflow) {
          log.warn(`[ai] ${requestId} silent context overflow: input=${outcome.value.usage?.inputTokens} model=${input.ctx.model}`);
        }
        emit({
          type: 'success',
          requestId,
          channelKey: key,
          usage: outcome.value.usage,
          durationMs,
          ...(contextOverflow ? { contextOverflow: true, model: input.ctx.model } : {}),
        });
        return {
          status: 'success',
          usage: outcome.value.usage,
          body: outcome.value.body,
          durationMs,
        };
      }
      const { error, empty } = outcome;
      log.error(`[ai] ${requestId} failed attempts=${attempts}`, {
        code: error.code,
        status: error.status,
      });
      if (empty) {
        emit({ type: 'empty_completion', requestId, channelKey: key, attempt: attempts });
      } else {
        emit({ type: 'failed', requestId, channelKey: key, error });
      }
      return { status: empty ? 'empty' : 'error', error, durationMs };
    },

    async chatStream(input) {
      const start = Date.now();
      const prepared = prepare(input);
      const { requestId, endpoint } = input.ctx;
      const key = prepared.ok ? prepared.key : 'unknown';
      // per-call 事件总线（终态缓冲 + 晚订阅重放语义见 stream-report.ts）
      const bus = createStreamEventBus(emit, { providerName: input.ctx.providerName, model: input.ctx.model });

      if (!prepared.ok) return failEarlyStream(bus, prepared.error, requestId, key);
      const { body, breaker, credential, adapter } = prepared;

      const refused = await admitRequest({ breaker, credential, requestId, key, log });
      if (refused) return failEarlyStream(bus, refused, requestId, key);

      const { plan, url } = planUpstream(adapter, input.channel, input.ctx, true);
      const rec = asRecord(body);
      const finalBody = rec
        ? adapter.finalizeRequestBody(rec, { endpoint, model: input.ctx.model, stream: true })
        : body;
      const { outcome, attempts } = await withRetry(
        createStreamAttempt({
          channel: input.channel, ctx: input.ctx, url, plan, finalBody,
          adapter, breaker, credential, cfg, log, emit, key,
        }),
        retryOptionsOf(cfg, input.ctx),
        (info) =>
          log.warn(`[ai] ${requestId} retry attempt=${info.attempt} delay=${info.delayMs}`, {
            code: info.error.code,
          }),
      );

      if (!outcome.ok) {
        const { error, empty } = outcome;
        log.error(`[ai] ${requestId} failed attempts=${attempts}`, {
          code: error.code,
          status: error.status,
        });
        if (empty) {
          // 流式空完成重试耗尽：发 empty_completion（gateway 换渠道），不计费（5.11 全程无输出）
          // failed 由 failEarly 统一发，这里只补 empty 语义事件
          bus.emitTerminal({ type: 'empty_completion', requestId, channelKey: key, attempt: attempts });
        }
        return failEarlyStream(bus, error, requestId, key);
      }
      const rest = outcome.value;
      // 先创建 relayStream（立即开始消费上游数据，防缓冲区堆积），
      // breaker/credential 的 Redis 写入在后面做（不阻塞数据流）。
      // 拿到首帧才算成功；状态写入 best-effort（fireAndForget 防 unhandledRejection）
      const handle = relayStream(rest, {
        heartbeatIdleMs: cfg.stream.heartbeatIdleMs,
        inactivityTimeoutMs: cfg.stream.inactivityTimeoutMs,
        signal: input.ctx.signal,
      });
      fireAndForget(breaker.recordSuccess());
      fireAndForget(credential.recordSuccess());
      attachRelayReporting(handle, {
        bus,
        breaker,
        requestId,
        channelKey: key,
        startedAt: start,
        log,
      });
      return { stream: handle.stream, onEvent: bus.onEvent };
    },

    async probe(channel) {
      // 配置校验（fail fast）：空 apiKey/baseUrl 不发垃圾请求
      const cfgErr = assertChannel(channel);
      if (cfgErr) return { ok: false, durationMs: 0, error: cfgErr };
      const adapter = resolveAdapter(channel);
      if ('code' in adapter) return { ok: false, durationMs: 0, error: adapter };
      return probeChannel({ channel, adapter, cfg });
    },

    onEvent(cb) {
      listeners.push(cb);
      return () => {
        const i = listeners.indexOf(cb);
        if (i >= 0) listeners.splice(i, 1);
      };
    },

    // ---- 异步生成任务操作面（仅 tasks 适配器提供；轮询为周期性只读，不进重试/熔断）----

    parseGenerationResponse: makeParseGenerationResponse(generationDeps),
    queryGenerationTask: makeQueryGenerationTask(generationDeps),
    retrieveGenerationFile: makeRetrieveGenerationFile(generationDeps),
  };
}
