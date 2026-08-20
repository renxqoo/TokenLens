import type { StreamError, UpstreamError, Usage } from './types';

/**
 * 调用全生命周期事件（gateway 消费：转计量事件 / 驱动候选循环 / 标 stream_aborted）。
 *
 * 事件顺序约定（同一次调用）：
 *   - 非流式：attempt_start* → [param_adjustment] → (success | (empty_completion | failed))
 *   - 流式：attempt_start* → first_chunk（首字节流向客户端，一次性）→ success
 *     （流内中断：aborted → success(terminated) ；流内错误帧：stream_error*）
 *   - done/success 一定最后发出（relay-stream 保证流尾事件顺序）
 *   - first_chunk 是 TTFB 的权威观察点：订阅晚于流开始的消费方（如 gateway）
 *     收不到 attempt_start，只能在此锚定首字节时刻
 *
 * 计费语义（requirements 5.11）：
 *   - usage 是流的随行状态：任何帧带的非 null usage 均视为累计值，最新者胜出
 *     （scanner 逐帧捕获；网关默认请求 include_usage + continuous_usage_stats，
 *     支持逐帧 usage 的供应商在客户端取消时也能拿到最新累计值）
 *   - success.terminated !== undefined → 流式中断，gateway 标 stream_aborted=true
 *   - 中断且 success.usage 为空 → 账务进入 uncertain，禁止把未知缓存命中估成 0 后直接扣费
 *     （中断但有可信累计 usage → 按最新 usage 正常结算）
 */
export type AiEvent =
  | { type: 'attempt_start'; requestId: string; channelKey: string; attempt: number }
  | { type: 'first_chunk'; requestId: string }
  | {
      type: 'param_adjustment';
      requestId: string;
      param: string;
      action: 'ignore' | 'clamp' | 'map';
      from?: unknown;
      to?: unknown;
    }
  | { type: 'usage'; requestId: string; usage: Usage; streamError?: StreamError }
  | { type: 'stream_error'; requestId: string; frame: StreamError }
  | {
      type: 'aborted';
      requestId: string;
      reason:
        | 'client_disconnect'
        | 'request_cancelled'
        | 'server_draining'
        | 'inactivity'
        | 'upstream_error'
        | 'upstream_disconnected'
        | 'upstream_truncated';
    }
  | { type: 'failed'; requestId: string; channelKey: string; error: UpstreamError }
  | { type: 'empty_completion'; requestId: string; channelKey: string; attempt: number }
  | {
      type: 'success';
      requestId: string;
      /** 渠道维度（gateway 多候选循环时区分哪个渠道成功/失败） */
      channelKey: string;
      usage?: Usage;
      durationMs: number;
      /**
       * 流式正常结束 = undefined；中断结束 = 中断原因。
       * gateway 据此标 stream_aborted 并走中断计费路径（5.11）。
       */
      terminated?:
        | 'client_disconnect'
        | 'request_cancelled'
        | 'server_draining'
        | 'inactivity'
        | 'upstream_error'
        | 'upstream_disconnected'
        | 'upstream_truncated';
      /**
       * 已透传给客户端的字节数（仅流式有意义）。
       * 用户侧取消且 usage 缺失时，gateway 按 bytesRelayed × K(model) 估算 output tokens
       * （见 usage-estimator.ts）；input tokens 用 estimateInputTokens（CJK 感知，与预扣同源）。
       */
      bytesRelayed?: number;
      /**
       * 扫描器累计的输出内容文本（规范形 delta 累积；仅流式有意义）。
       * usage 缺失或用户中途取消时，gateway 用校准估算器从该文本估算 output tokens
       * （输出按 0 计费 = 系统性漏收——取消刷输出是真实攻击面）。
       */
      outputText?: string;
      /** [DONE] 哨兵是否到达（观测/计费留痕：区分自然完成与终止后断开） */
      doneSentinel?: boolean;
      /** 终止帧（finish_reason）是否到达 */
      terminalFrame?: boolean;
      /**
       * 静默溢出旗标（可观测信号，不翻转成功语义）：usage.inputTokens 超过
       * 模型上下文窗口（models.dev 快照）——部分供应商对超窗输入静默截断。
       * 计费仍按供应商 usage（正确口径）；旗标供网关日志/告警消费。
       */
      contextOverflow?: boolean;
      /** 溢出时的模型名（告警消费；仅 contextOverflow 时携带） */
      model?: string;
    };
