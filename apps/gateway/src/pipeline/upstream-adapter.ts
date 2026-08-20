/**
 * 生产上游适配器：UpstreamPort 的 packages/ai 实现。
 * 候选渠道连接信息 → ChannelDesc（apiKeyEnc 经 core.decrypt 解密，v1/v2 前缀自动选代）；
 * ai 的归一化结果 → 端口契约（usage 带 estimated 旗标 = 不可信 → 上抛为缺 usage，
 * 由管线的估算归属政策处理）。Redis 熔断/死凭据存储是运营加固项——当前进程内存。
 */
import { decrypt } from '@ai-gateway/core';
import type { Ai } from '@ai-gateway/ai';
import type { RouteCandidateRow } from '@ai-gateway/repository';
import type {
  UpstreamChatRequest,
  UpstreamPort,
  UpstreamResult,
  UpstreamStreamEvent,
  UpstreamStreamResult,
} from './upstream-port.js';

export function createUpstreamAdapter(deps: {
  ai: Ai;
  encryptionKey: string;
  /** 上游调用总预算 ms（deadlineMs 传入 ai 包重试/熔断面；缺省不限） */
  deadlineMs?: number;
}): UpstreamPort {
  const deadline = () => (deps.deadlineMs != null ? { deadlineMs: deps.deadlineMs } : {});  return {
    async chat(candidate: RouteCandidateRow, request: UpstreamChatRequest): Promise<UpstreamResult> {
      const result = await deps.ai.chat({
        channel: {
          baseUrl: candidate.baseUrlOverride ?? candidate.providerBaseUrl,
          apiKey: decrypt(candidate.apiKeyEnc, deps.encryptionKey),
          protocol: candidate.providerProtocol,
          ...(candidate.providerVendor != null ? { vendor: candidate.providerVendor } : {}),
        },
        request: request.body,
        ctx: {
          requestId: request.requestId,
          model: request.realModel,
          providerName: candidate.providerName,
          endpoint: request.endpoint,
          ...deadline(),
        },
      });
      if (result.status === 'success') {
        if (result.rawBody) {
          return {
            ok: true,
            body: {},
            rawBody: result.rawBody,
            rawContentType: result.rawContentType ?? 'application/octet-stream',
            ...(result.usage && !result.usage.estimated
              ? { usage: { inputTokens: result.usage.inputTokens, cachedInputTokens: result.usage.cachedInputTokens, outputTokens: result.usage.outputTokens, ...(result.usage.cacheWriteTokens != null ? { cacheWriteTokens: result.usage.cacheWriteTokens } : {}) } }
              : {}),
          };
        }
        return {
          ok: true,
          body: (result.body as Record<string, unknown>) ?? {},
          ...(result.usage && !result.usage.estimated
            ? {
                usage: {
                  inputTokens: result.usage.inputTokens,
                  cachedInputTokens: result.usage.cachedInputTokens,
                  outputTokens: result.usage.outputTokens,
                  ...(result.usage.cacheWriteTokens != null ? { cacheWriteTokens: result.usage.cacheWriteTokens } : {}),
                },
              }
            : {}),
        };
      }
      if (!result.error) {
        return { ok: false, error: { code: 'invalid_response', message: 'upstream returned neither body nor error' } };
      }
      return {
        ok: false,
        status: result.error.status,
        error: {
          code: result.error.code,
          message: result.error.message,
          deadCredential: result.error.deadCredential,
        },
      };
    },

    async chatStream(candidate, request): Promise<UpstreamStreamResult> {
      const result = await deps.ai.chatStream({
        channel: {
          baseUrl: candidate.baseUrlOverride ?? candidate.providerBaseUrl,
          apiKey: decrypt(candidate.apiKeyEnc, deps.encryptionKey),
          protocol: candidate.providerProtocol,
          ...(candidate.providerVendor != null ? { vendor: candidate.providerVendor } : {}),
        },
        request: request.body,
        ctx: {
          requestId: request.requestId,
          model: request.realModel,
          providerName: candidate.providerName,
          endpoint: request.endpoint,
          ...deadline(),
        },
      });
      // 端口契约「订阅晚于事件发出时重放」在适配器兜底：真 ai 只重放终态事件
      // （first_chunk 可能在 peek 阶段已发出且不缓冲）——此处立即订阅并全量缓冲，
      // 晚订阅者重放已发事件（换渠判定与终态收据都不丢事件）。
      const listeners: Array<(event: UpstreamStreamEvent) => void> = [];
      const emitted: UpstreamStreamEvent[] = [];
      result.onEvent((event) => {
        const mapped: UpstreamStreamEvent | null =
          event.type === 'failed'
            ? {
                type: 'failed',
                code: event.error.code,
                message: event.error.message,
                deadCredential: event.error.deadCredential,
                status: event.error.status,
              }
            : event.type === 'first_chunk'
              ? { type: 'first_chunk' }
              : event.type === 'success'
                ? {
                    type: 'success',
                    ...(event.usage
                      ? {
                          usage: {
                            inputTokens: event.usage.inputTokens,
                            cachedInputTokens: event.usage.cachedInputTokens,
                            outputTokens: event.usage.outputTokens,
                            estimated: event.usage.estimated,
                            ...(event.usage.cacheWriteTokens != null ? { cacheWriteTokens: event.usage.cacheWriteTokens } : {}),
                          },
                        }
                      : {}),
                    ...(event.terminated !== undefined ? { terminated: event.terminated } : {}),
                    ...(event.bytesRelayed !== undefined ? { bytesRelayed: event.bytesRelayed } : {}),
                    ...(event.outputText !== undefined ? { outputText: event.outputText } : {}),
                  }
                : null;
        if (mapped === null) return;
        emitted.push(mapped);
        for (const cb of listeners) cb(mapped);
      });
      return {
        stream: pumpThrough(result.stream),
        onEvent: (cb) => {
          listeners.push(cb);
          for (const event of emitted) cb(event);
        },
      };
    },
  };
}

/**
 * 泵式透传：立即消费源流（真 ai 的事件是读取驱动——换渠判定在客户端读流之前，
 * 不泵就没人驱动 first_chunk/终态事件 = 死锁），帧入队缓冲，下游按需排水。
 * 正常路径客户端立即接续读取，缓冲只覆盖判定窗口（毫秒级）；取消向下传播。
 */
export function pumpThrough(source: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> {
  const reader = source.getReader();
  const chunks: Uint8Array[] = [];
  // 读侧闭包与 pull 循环共享的泵状态（属性变更——跨闭包可变性的单一载体）
  const pump = { finished: false, failure: null as unknown };
  let wake: (() => void) | null = null;
  const notify = () => { wake?.(); wake = null; };

  void (async () => {
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        notify();
      }
    } catch (error) {
      pump.failure = error;
    } finally {
      pump.finished = true;
      notify();
    }
  })();

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      while (chunks.length === 0 && !pump.finished && pump.failure === null) {
        await new Promise<void>((resolve) => { wake = resolve; });
      }
      if (pump.failure !== null) {
        controller.error(pump.failure instanceof Error ? pump.failure : new Error(String(pump.failure)));
        return;
      }
      while (chunks.length > 0) controller.enqueue(chunks.shift()!);
      if (pump.finished) controller.close();
    },
    cancel(reason) {
      void reader.cancel(reason).catch(() => {});
    },
  });
}
