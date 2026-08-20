/**
 * 上游端口（管线与 LLM 传输的接缝）：管线只依赖本端口——候选渠道连接信息进，
 * 归一化结果出。生产适配器（packages/ai createAi + apiKeyEnc 解密 + SSE）是 G4b；
 * 测试注入 stub 验证资金编排。死凭据判定信 ai 包 classify 的 deadCredential 标志。
 */
import type { Endpoint } from '@ai-gateway/ai';
import type { RouteCandidateRow } from '@ai-gateway/repository';

export interface UpstreamChatRequest {
  requestId: string;
  realModel: string;
  externalModel: string;
  /** 调用端点（ai 包 RequestCtx.endpoint 的端口形态——路由边界已知，必填显式传递） */
  endpoint: Endpoint;
  body: Record<string, unknown>;
}

export interface UpstreamUsage {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  /** 缓存写入 token（Anthropic cache_creation 归一；缺省 = 无） */
  cacheWriteTokens?: number;
}

export type UpstreamResult =
  | {
      ok: true;
      body: Record<string, unknown>;
      usage?: UpstreamUsage;
      /** 二进制成功体（audio_speech——原样字节回传，JSON 信封会毁掉流） */
      rawBody?: Uint8Array;
      rawContentType?: string;
    }
  | {
      ok: false;
      /** 上游原始状态码（4xx 透传语义——客户端问题原码返回，不吞成 502） */
      status?: number;
      error: { code?: string; message?: string; deadCredential?: boolean };
    };

/** 流式结果（ai 包 ChatStreamResult 的端口形态——透传管道 + 终态事件） */
export interface UpstreamStreamResult {
  stream: ReadableStream<Uint8Array>;
  /** 订阅全生命周期事件（first_chunk / failed / success(usage/terminated/bytesRelayed)） */
  onEvent: (cb: (event: UpstreamStreamEvent) => void) => void;
}

export type UpstreamStreamEvent =
  | { type: 'first_chunk' }
  | { type: 'failed'; code?: string; message?: string; deadCredential?: boolean; status?: number }
  | {
      type: 'success';
      usage?: UpstreamUsage & { estimated: boolean } & { cacheWriteTokens?: number };
      terminated?: string;
      bytesRelayed?: number;
      /** 扫描器累计的输出文本（usage 缺失/取消时的输出 token 估算源） */
      outputText?: string;
    };

export interface UpstreamPort {
  chat(candidate: RouteCandidateRow, request: UpstreamChatRequest): Promise<UpstreamResult>;
  chatStream(candidate: RouteCandidateRow, request: UpstreamChatRequest): Promise<UpstreamStreamResult>;
}
