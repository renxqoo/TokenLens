/**
 * 流式终态报告件（从 create-ai.chatStream 拆出）：
 *   - per-call 事件总线：终态事件缓冲 + 晚订阅重放（订阅晚于 failEarly 同步发事件的场景）
 *   - failEarly：流开始前失败 → 含 OpenAI 兼容错误帧的流 + failed 终态
 *   - relay 事件翻译：relayStream 的管线事件 → AiEvent（usage 归一 + terminated 随行）
 */
import type { CircuitBreaker } from '../breaker/breaker';
import type { RelayStreamHandle, RelayStreamEvent } from '../transport/relay-stream';
import { normalizeUsage } from '../usage/normalize';
import type { AiEvent } from '../events';
import type { ChatStreamResult, UpstreamError } from '../types';
import { detectSilentOverflow } from '../errors/overflow';
import { emitTo, fireAndForget } from './context';

export interface StreamEventBus {
  /** 溢出判定用的供应商标识（ctx 投影） */
  providerName?: string;
  model?: string;
  /** 全局 + per-call 双发（流开始后的常规事件） */
  emitStream: (e: AiEvent) => void;
  /** 终态事件（同步确定，早于 handle 返回）：推全局 + 缓冲供 onEvent 重放 */
  emitTerminal: (e: AiEvent) => void;
  /** 注册 per-call 回调并重放已缓冲的终态事件 */
  onEvent: (cb: (e: AiEvent) => void) => void;
}

/** per-call 事件总线（ChatStreamResult.onEvent 的背衬；与全局 emit 同时通知） */
export function createStreamEventBus(
  emit: (e: AiEvent) => void,
  meta: { providerName?: string; model?: string } = {},
): StreamEventBus {
  const perCallListeners: Array<(e: AiEvent) => void> = [];
  const lateEvents: AiEvent[] = [];
  return {
    providerName: meta.providerName,
    model: meta.model,
    emitStream: (e) => {
      emit(e); // 全局总线（gateway 计量/排障）
      emitTo(perCallListeners, e); // 本次流专用回调
    },
    emitTerminal: (e) => {
      emit(e);
      lateEvents.push(e);
    },
    onEvent: (cb) => {
      perCallListeners.push(cb);
      for (const ev of lateEvents) cb(ev);
    },
  };
}

/** 流开始前失败：返回含错误帧的流 + failed 终态事件（gateway 统一收敛） */
export function failEarlyStream(
  bus: StreamEventBus,
  error: UpstreamError,
  requestId: string,
  channelKey: string,
): ChatStreamResult {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const frame = JSON.stringify({
        error: {
          code: error.code,
          message: error.message,
          ...(error.status !== undefined ? { status: error.status } : {}),
        },
      });
      controller.enqueue(new TextEncoder().encode(`data: ${frame}\n\n`));
      controller.close();
    },
  });
  bus.emitTerminal({ type: 'failed', requestId, channelKey, error });
  return { stream, onEvent: bus.onEvent };
}

/** relay 管线事件 → AiEvent 翻译并挂到 handle（B2/B6 语义见 create-ai 原注释） */
export function attachRelayReporting(
  handle: RelayStreamHandle,
  deps: {
    bus: StreamEventBus;
    breaker: CircuitBreaker;
    requestId: string;
    channelKey: string;
    startedAt: number;
    log: { warn: (msg: string, ...args: unknown[]) => void };
  },
): void {
  const { bus, breaker, requestId, channelKey, startedAt, log } = deps;
  handle.onEvent((ev: RelayStreamEvent) => {
    switch (ev.type) {
      case 'first_chunk':
        // TTFB 权威观察点：上游首字节流向客户端（一次性），转发给晚订阅的消费方
        bus.emitStream({ type: 'first_chunk', requestId });
        break;
      case 'stream_error':
        bus.emitStream({ type: 'stream_error', requestId, frame: ev.frame });
        break;
      case 'aborted':
        bus.emitStream({ type: 'aborted', requestId, reason: ev.reason });
        // B6：非客户端断开 → 计入熔断（渠道故障或协议错误）
        // client_disconnect 是用户主动断开，server_draining 是本服务停机，
        // 均非渠道问题，不计熔断
        if (ev.reason !== 'client_disconnect' && ev.reason !== 'server_draining') {
          fireAndForget(breaker.recordFailure({ circuitTrip: true }));
        }
        break;
      case 'done': {
        const usage = ev.usage !== null ? normalizeUsage(ev.usage) : null;
        // 静默溢出可观测（流式：已交付不翻转，旗标进 success 事件）
        const contextOverflow = usage
          ? detectSilentOverflow(usage.inputTokens, bus.providerName, bus.model)
          : false;
        if (contextOverflow) {
          log.warn(`[ai] ${requestId} silent context overflow: input=${usage?.inputTokens} model=${bus.model}`);
        }
        if (usage) {
          bus.emitStream({
            type: 'usage',
            requestId,
            usage,
            streamError: ev.errorFrame ?? undefined,
          });
        } else if (ev.errorFrame) {
          log.warn(`[ai] ${requestId} stream ended without usage`, ev.errorFrame);
        }
        // B2：把 terminated + bytesRelayed 带到 success（gateway 据此判定 stream_aborted + 估算）
        bus.emitStream({
          type: 'success',
          requestId,
          channelKey,
          usage: usage ?? undefined,
          durationMs: Date.now() - startedAt,
          terminated: ev.terminated,
          bytesRelayed: ev.bytesRelayed,
          outputText: ev.outputText,
          doneSentinel: ev.doneSentinel,
          terminalFrame: ev.terminalFrame,
          ...(contextOverflow ? { contextOverflow: true, model: bus.model } : {}),
        });
        break;
      }
    }
  });
}
