/**
 * runChat 用例（管线编排核心——app 层，零业务规则；流式/非流式双分支）：
 *
 *   报价（G2）→ 资金预扣（service.authorize，requestId=请求 ID 幂等）
 *   → 候选模型 × 各自渠道调度序（G3）双层循环：敞口预留（reserveChannel）→ 上游（端口）
 *     非流式：可换错误 → 下一渠道/模型；4xx → 直接失败
 *     流式：  first_chunk 前失败同非流式换渠；上线后不换（流内错误已转错误帧）
 *   → 成功：收据（命中候选价格快照 + 可信/估算 usage）→ signal(succeeded)
 *     全败：signal(failed) 三路归还 → 502 信封
 *   死凭据 → 渠道落库 status=4 后继续
 *
 * Redis 状态共享 / OTel = G4d 运营加固。
 */
import { estimateInputTokens, estimateOutputTokens, estimateTextTokens, type Endpoint } from '@ai-gateway/ai';
import { estimateMaxCost, USER_SIDE_CANCELS } from '@ai-gateway/domain';
import type { UsageReceipt } from '@ai-gateway/domain';
import { getTracer, SpanStatusCode, withAsyncSpan } from '@ai-gateway/core';
import { createRepositories } from '@ai-gateway/repository';
import type { Db, Repositories } from '@ai-gateway/repository';
import type { BillingDomain, RunContext } from '@ai-gateway/service';
import { AppError } from '../http/error-map.js';
import type { AuthContext } from '../middleware/api-key.js';
import { createBuildQuote } from '../quote/build-quote.js';
import { createResolveChannels } from '../routing/resolve-channels.js';
import { isChannelSwitchable } from '../routing/switchable.js';
import { clampForwardedOutputLimit, maxOutputTokensFor, type OutputCapConfig } from './output-cap.js';
import { buildReceipt } from './receipt.js';
import { admitFreeDaily, admitKey, reserveModelDims, tryChannel, type RateLimitGate } from '../rate-limit/gate.js';
import { sanitizeUpstreamDetail } from '../http/sanitize.js';
import type { UpstreamPort, UpstreamStreamEvent } from './upstream-port.js';

type BuildQuote = ReturnType<typeof createBuildQuote>;
type ResolveChannels = ReturnType<typeof createResolveChannels>;

export interface RunChatConfig {
  reservationLimit: string;
  authorizationTtlMs: number;
  output: OutputCapConfig;
}

/** 端点分类（显式 endpoint 的纯函数——曾用 body 魔法字段 + 形状推断双轨，
 *  现单一真相：路由边界声明的端点；chat/embeddings 之外的一切都属模态族）。 */
function kindOf(endpoint: Endpoint): 'chat' | 'embeddings' | 'modality' {
  if (endpoint === 'chat' || endpoint === 'embeddings') return endpoint;
  return 'modality';
}

export interface ChatCompletionBody {
  model: string;
  messages: unknown[];
  stream?: boolean;
  [key: string]: unknown;
}

export interface PipelineDeps {
  db: Db;
  billing: BillingDomain;
  buildQuote: BuildQuote;
  resolveChannels: ResolveChannels;
  upstream: UpstreamPort;
  config: RunChatConfig;
  repos?: Repositories;
  /** 限流闸（Redis 装配注入；未装配 = 单副本开发形态全放行） */
  rateLimit?: RateLimitGate;
  /** 死凭据落库失败只记日志不阻塞请求 */
  onError?: (error: unknown, context: string) => void;
}

export type ChatResponse =
  | { status: number; body: Record<string, unknown> }
  | { status: 200; stream: ReadableStream<Uint8Array>; contentType: 'text/event-stream' }
  /** 二进制成功（音频等）：字节体 + 上游 content-type（v1 对位——JSON 信封会毁掉字节流） */
  | { status: 200; rawBody: Uint8Array; rawContentType: string };

/** 流式终态（success 事件）→ 收据 usage 形态（估算归属政策单一真相在 domain）。
 *  usage 缺失/不可信时输出 token 从扫描器累计的输出文本校准估算（与输入同一估算器）
 *  ——输出按 0 计费 = 「取消刷输出」「无 usage 供应商白嫖」两个真实漏收面。 */
function streamReceiptUsage(
  event: Extract<UpstreamStreamEvent, { type: 'success' }>,
  estInput: number,
): Pick<UsageReceipt, 'usage' | 'estimatedFor' | 'bytesRelayed' | 'streamAborted'> {
  const usage = event.usage;
  if (usage && !usage.estimated) {
    return {
      usage: {
        inputTokens: usage.inputTokens,
        cachedInputTokens: usage.cachedInputTokens,
        outputTokens: usage.outputTokens,
        estimated: false,
        ...(((usage as { cacheWriteTokens?: number }).cacheWriteTokens ?? 0) > 0
          ? { cacheWriteTokens: (usage as { cacheWriteTokens?: number }).cacheWriteTokens }
          : {}),
      },
      streamAborted: false,
    };
  }
  const terminated = event.terminated;
  const userCancelled = terminated != null && (USER_SIDE_CANCELS as readonly string[]).includes(terminated);
  // 模型族解析编码器（BPE 主路径，编码器不可用回落启发式）
  const estOutput = estimateTextTokens(event.outputText ?? '');
  return {
    usage: {
      inputTokens: usage?.inputTokens ?? estInput,
      cachedInputTokens: 0,
      outputTokens: estOutput,
      estimated: true,
    },
    estimatedFor: userCancelled ? 'client_disconnect' : 'usage_missing_completed',
    bytesRelayed: event.bytesRelayed ?? 0,
    streamAborted: terminated != null,
  };
}

/** 终态 signal 退避重试：结算落账的瞬时 DB 抖动不再把已交付请求漏收——
 *  流式路径重试期间续租定时器不停（调用方约定），recover 不会中途误释放；
 *  耗尽返回 false 由调用方兜底（流式 = 停租约交 recover 释放记损；非流式 = 上抛 500）。 */
export const SIGNAL_FINALIZE_ATTEMPTS = 5;
const SIGNAL_FINALIZE_BASE_DELAY_MS = 500;

export async function signalSucceededWithRetry(
  billing: BillingDomain,
  ctx: RunContext,
  requestId: string,
  receipt: UsageReceipt,
  onError: (error: unknown, context: string) => void,
  opts: { attempts?: number; baseDelayMs?: number } = {},
): Promise<boolean> {
  const attempts = opts.attempts ?? SIGNAL_FINALIZE_ATTEMPTS;
  const baseDelayMs = opts.baseDelayMs ?? SIGNAL_FINALIZE_BASE_DELAY_MS;
  // 结算信号 span：流式/非流式共用；重试逐次 addEvent，耗尽置 ERROR（漏收可见）
  return withAsyncSpan(getTracer('gateway.pipeline'), 'billing.settle_signal', {
    'request.id': requestId,
    ...(receipt.userId != null ? { 'user.id': receipt.userId } : {}),
    ...(receipt.externalModel != null ? { 'ai.model': receipt.externalModel } : {}),
    ...(receipt.channelKey != null ? { 'channel.key': receipt.channelKey } : {}),
    ...(receipt.usage
      ? {
          'usage.estimated': receipt.usage.estimated,
          'tokens.input': receipt.usage.inputTokens,
          'tokens.output': receipt.usage.outputTokens,
        }
      : {}),
    'billing.stream': receipt.stream,
  }, async (span) => {
    for (let attempt = 1; attempt <= attempts; attempt++) {
      try {
        await billing.signal(ctx, { type: 'request.succeeded', requestId, receipt });
        return true;
      } catch (error) {
        onError(error, `signal request.succeeded request=${requestId} attempt=${attempt}/${attempts}`);
        if (attempt < attempts) {
          span.addEvent('signal.retry', { attempt });
          await new Promise((resolve) => setTimeout(resolve, Math.min(8_000, baseDelayMs * 2 ** (attempt - 1))));
        }
      }
    }
    span.setStatus({ code: SpanStatusCode.ERROR, message: 'signal retries exhausted' });
    return false;
  });
}

export function createRunChat(deps: PipelineDeps) {
  const repos = deps.repos ?? createRepositories();
  const noteError = deps.onError ?? ((error, context) => console.error(`[pipeline] ${context}:`, error));
  return async function runChat(
    ctx: RunContext,
    auth: Pick<AuthContext, 'userId' | 'apiKeyId' | 'appId' | 'rpmLimit' | 'tpmLimit' | 'userRpmLimit' | 'userTpmLimit' | 'allowedModels'>,
    body: ChatCompletionBody,
    endpoint: Endpoint,
  ): Promise<ChatResponse> {
    const tracer = getTracer('gateway.pipeline');
    const requestId = ctx.requestId;
    // 模型白名单（App JWT scope.models）：预扣前拒绝——受限凭证调未授权模型的越权计费
    if (auth.allowedModels != null && !auth.allowedModels.includes(body.model)) {
      throw new AppError(403, 'model_not_allowed', `模型 ${body.model} 不在该凭证的授权范围内`);
    }
    const estInput = estimateInputTokens(body, { model: body.model });
  // 请求时点汇率快照（60s 进程缓存）：预取不阻塞授权关键路径（CI 慢机上多一次
  // DB 往返会挤占流租约续租时序）——装配收据时才 await；查询失败降级 null
  const fxPromise = repos.fx.current({ ...ctx, db: deps.db }).catch(() => null);
    const kind = kindOf(endpoint);
    const outputCap = maxOutputTokensFor(kind === 'modality' ? 'embeddings' : kind, body, deps.config.output);
    const stream = body.stream === true;
    const estimatedTokens = estInput + outputCap;
    // 预扣口径与上游实许输出对齐：声明超口径的输出上限压回口径内（不注入——兼容优先）
    const upstreamBody = clampForwardedOutputLimit(body as Record<string, unknown>, outputCap);

    // 准入并罚（v1 五维语义的 v2 形态）：凭证维 + 用户维各自生效——
    // 高限额 Key 不得越过用户帽；用户维无条件在列（App-JWT 的 scope 限额
    // 只约束 app 维——用户自建 App 声明大 scope 不得绕过管理端用户帽）；
    // 未装配限流闸时全放行（单副本开发形态）
    if (deps.rateLimit) {
      const credentialDimension =
        auth.apiKeyId != null ? `key:${auth.apiKeyId}` : auth.appId != null ? `app:${auth.appId}` : `pg:${auth.userId}`;
      await withAsyncSpan(tracer, 'rate_limit.admit', {
        'request.id': requestId,
        'user.id': auth.userId,
        'rate_limit.credential_dim': credentialDimension,
        'tokens.estimate': estimatedTokens,
      }, () =>
        admitKey(deps.rateLimit!, {
          requestId,
          estimatedTokens,
          dims: [
            {
              dimension: credentialDimension,
              rpmLimit: auth.rpmLimit ?? null,
              tpmLimit: auth.tpmLimit ?? null,
            },
            {
              dimension: `user:${auth.userId}`,
              rpmLimit: auth.userRpmLimit ?? null,
              tpmLimit: auth.userTpmLimit ?? null,
            },
          ],
        }),
      );
    }

    // 报价/免费额度可能拒绝（404/403/429）——TPM 已预占，失败路径同样归还
    // （其余罕见异常路径由 600s 预占 TTL 自回收，同 v1 语义）
    let quote;
    try {
      quote = await withAsyncSpan(tracer, 'quote.build', {
        'request.id': requestId,
        'user.id': auth.userId,
        'ai.model': body.model,
      }, async (span) => {
        const q = await deps.buildQuote(ctx, {
          model: body.model,
          userId: auth.userId,
          inputTokenUpperBound: estInput,
          maxOutputTokens: outputCap,
          body: body as Record<string, unknown>,
        });
        span.setAttributes({ 'quote.candidates': q.candidates.length, 'quote.free': q.explicitlyFree });
        return q;
      });
    } catch (error) {
      if (deps.rateLimit) await deps.rateLimit.limiter.releaseTpm(requestId).catch(() => {});
      throw error;
    }
    if (quote.candidates.length === 0) {
      // TPM 已预占（admitKey）——404 拒绝同样归还，防 600s 预占泄漏
      if (deps.rateLimit) await deps.rateLimit.limiter.releaseTpm(requestId).catch(() => {});
      throw new AppError(404, 'model_not_found', '模型不存在或已下架');
    }
    // 模型维 TPM 预占（主 + fallback 候选 mappingId 一并占住——v1 reserveFallbackDims 语义）
    if (deps.rateLimit) {
      await withAsyncSpan(tracer, 'rate_limit.reserve_model', {
        'request.id': requestId,
        'ai.model': body.model,
        'tokens.estimate': estimatedTokens,
      }, () =>
        reserveModelDims(deps.rateLimit!, {
          requestId,
          mappingIds: quote.candidates.map((candidate) => candidate.mappingId),
          tpmLimit: auth.userTpmLimit ?? auth.tpmLimit ?? null,
          estimatedTokens,
        }),
      );
    }

    // 免费模型日限（唯一防线——fail-closed，与付费限流的 fail-open 语义相反）
    if (deps.rateLimit && quote.explicitlyFree) {
      try {
        await withAsyncSpan(tracer, 'rate_limit.free_daily', {
          'request.id': requestId,
          'user.id': auth.userId,
        }, () => admitFreeDaily(deps.rateLimit!, auth.userId));
      } catch (error) {
        await deps.rateLimit.limiter.releaseTpm(requestId).catch(() => {});
        throw error;
      }
    }

    // 授权可能拒绝（402/限额/配置）
    let authorization;
    try {
      authorization = await withAsyncSpan(tracer, 'billing.authorize', {
        'request.id': requestId,
        'user.id': auth.userId,
        'ai.model': body.model,
        'billing.stream': stream,
      }, () =>
        deps.billing.authorize(ctx, {
          requestId,
          userId: auth.userId,
          apiKeyId: auth.apiKeyId,
          // App-JWT 凭证的订阅绑定（resolveSourceAndLimits 按它取订阅——漏传=App 全走 PAYG）
          appId: auth.appId ?? null,
          stream,
          quote,
          reservationLimit: deps.config.reservationLimit,
          authorizationTtlMs: deps.config.authorizationTtlMs,
          // 请求根 span 的 traceparent 落列——worker 结算按它挂回同一 trace
          traceParent: ctx.traceParent,
        }),
      );
    } catch (error) {
      if (deps.rateLimit) await deps.rateLimit.limiter.releaseTpm(requestId).catch(() => {});
      throw error;
    }
    void authorization;

    let leaseStarted = false;
    let lastError: { code?: string; message?: string; status?: number } | undefined;
    /** 上游 4xx 透传（OpenAI 兼容语义：客户端问题原码返回——不吞成 502、不空耗 fallback）。
     *  透传≠免收尾：TPM 预占归还 + request.failed 三路释放（4xx = 上游确定未计费） */
    const passthrough4xx = async (error: {
      code?: string; message?: string; status?: number;
    }): Promise<ChatResponse> =>
      withAsyncSpan(tracer, 'billing.passthrough_4xx', {
        'request.id': requestId,
        'error.code': error.code ?? 'upstream_client_error',
        'http.status_code': error.status ?? 0,
      }, async (span) => {
        span.setStatus({ code: SpanStatusCode.ERROR, message: error.code ?? 'upstream_client_error' });
        if (deps.rateLimit) await deps.rateLimit.limiter.releaseTpm(requestId).catch(() => {});
        await deps.billing.signal(ctx, {
          type: 'request.failed',
          requestId,
          reason: (error.code ?? 'upstream_client_error').slice(0, 64),
        });
        return {
          status: error.status != null && error.status >= 400 && error.status < 500 ? error.status : 502,
          body: {
            error: {
              code: error.code ?? 'upstream_error',
              message: sanitizeUpstreamDetail(error.message, {
                externalModel: body.model,
                realModels: quote.candidates.map((c) => c.realModel),
              }),
            },
          },
        };
      });
    const startChannel = async (channelId: number, amount: string, channelKey: string): Promise<boolean> => {
      const reservation = await deps.billing.reserveChannel(ctx, { requestId, channelId, amount });
      if (!reservation.allowed) {
        lastError = { code: 'channel_budget_exhausted' };
        await withAsyncSpan(tracer, 'channel.skip', {
          'request.id': requestId,
          'channel.key': channelKey,
          'skip.reason': 'budget_exhausted',
        }, async () => {});
        return false;
      }
      if (!leaseStarted) {
        await deps.billing.signal(ctx, {
          type: 'upstream.started',
          requestId,
          leaseOwner: 'gateway',
          leaseMs: deps.config.authorizationTtlMs,
        });
        leaseStarted = true;
      }
      return true;
    };
    /** 全败收尾：TPM 预占归还（无上游执行的失败）→ request.failed 三路归还 → 502
     *  （message 脱敏：真实模型名等内部细节进日志不进响应） */
    const releaseAndFail = async (): Promise<never> =>
      withAsyncSpan(tracer, 'billing.release_and_fail', {
        'request.id': requestId,
        'user.id': auth.userId,
        'error.code': lastError?.code ?? 'no_available_channel',
      }, async () => {
        if (deps.rateLimit) await deps.rateLimit.limiter.releaseTpm(requestId).catch(() => {});
        // v1 语义：从未得到上游响应、纯渠道面拒绝（限流/预算耗尽）= 503 no_available_channel
        const channelExhausted =
          lastError == null || lastError.code === 'channel_budget_exhausted' || lastError.code === 'rate_limit_exceeded';
        await deps.billing.signal(ctx, {
          type: 'request.failed',
          requestId,
          reason: (channelExhausted ? 'no_available_channel' : (lastError?.code ?? 'no_available_channel')).slice(0, 64),
        });
        if (channelExhausted) {
          throw new AppError(503, 'no_available_channel', '模型所有渠道均不可用，请稍后重试');
        }
        throw new AppError(
          502,
          'upstream_failed',
          sanitizeUpstreamDetail(lastError?.message, {
            externalModel: body.model,
            realModels: quote.candidates.map((candidate) => candidate.realModel),
          }),
        );
      });
    const markDead = async (channelId: number): Promise<void> => {
      try {
        await deps.db.transaction((tx) => repos.channel.markDeadCredential({ ...ctx, db: tx }, channelId));
      } catch (error) {
        noteError(error, `mark dead credential channel=${channelId}`);
      }
    };

    for (const candidate of quote.candidates) {
      const channels = await withAsyncSpan(tracer, 'routing.resolve', {
        'request.id': requestId,
        'ai.model': candidate.realModel,
      }, async (span) => {
        const list = await deps.resolveChannels(ctx, candidate.realModel);
        span.setAttribute('routing.channels', list.length);
        return list;
      });
      const upstreamEstimate = estimateMaxCost({
        estimatedInputTokens: estInput,
        maxOutputTokens: outputCap,
        inputPrice: candidate.inputPrice,
        cacheInputPrice: candidate.cacheInputPrice,
        cacheWritePrice: candidate.cacheWritePrice,
        outputPrice: candidate.outputPrice,
        unitPrice: candidate.unitPrice ?? 0,
        unitUpperBound: candidate.unitUpperBound ?? 0,
        coefficient: '1',
      }).toString();

      let channelAttempt = 0;
      for (const channel of channels) {
        channelAttempt += 1;
        // 渠道维尝试前判定（超限视同可换渠：continue 换下一渠道）
        if (deps.rateLimit && !(await tryChannel(deps.rateLimit, {
          requestId,
          channelId: channel.channelId,
          rpmLimit: channel.rpmLimit,
          tpmLimit: channel.tpmLimit,
          estimatedTokens,
        }))) {
          lastError = { code: 'rate_limit_exceeded', message: '渠道限流' };
          await withAsyncSpan(tracer, 'channel.skip', {
            'request.id': requestId,
            'channel.key': channel.channelName,
            'channel.attempt': channelAttempt,
            'skip.reason': 'rate_limited',
          }, async () => {});
          continue;
        }
        if (!(await startChannel(channel.channelId, upstreamEstimate, channel.channelName))) continue;

        if (!stream) {
          // ---- 非流式：同步结果 ----
          const startedAt = Date.now();
          const result = await withAsyncSpan(tracer, 'upstream.attempt', {
            'request.id': requestId,
            'user.id': auth.userId,
            'channel.key': channel.channelName,
            'channel.attempt': channelAttempt,
            'ai.model': candidate.realModel,
            'upstream.stream': false,
          }, async (span) => {
            const r = await deps.upstream.chat(channel, {
              requestId, realModel: candidate.realModel, externalModel: body.model, endpoint, body: upstreamBody,
            });
            if (r.ok) {
              span.setAttributes({
                'upstream.ok': true,
                'upstream.duration_ms': Date.now() - startedAt,
                ...(r.usage ? { 'tokens.input': r.usage.inputTokens, 'tokens.output': r.usage.outputTokens } : {}),
              });
            } else {
              span.setAttributes({
                'upstream.ok': false,
                'upstream.error_code': r.error.code ?? 'upstream_error',
                ...(r.status != null ? { 'http.status_code': r.status } : {}),
                ...(r.error.deadCredential ? { 'upstream.dead_credential': true } : {}),
              });
              span.setStatus({ code: SpanStatusCode.ERROR, message: r.error.code ?? 'upstream_error' });
            }
            return r;
          });
          const durationMs = Date.now() - startedAt;
          if (result.ok) {
            // 结算 signal 退避重试：瞬时 DB 抖动自愈；耗尽上抛 500（未交付不结算——
            // 与「先落账后交付」纪律一致，宁可让用户重试也不白送）
            const receipt = buildReceipt({
              requestId, userId: auth.userId, apiKeyId: auth.apiKeyId, appId: auth.appId ?? null, candidate,
              externalModel: body.model, channelId: channel.channelId, channelKey: channel.channelName,
              durationMs, fx: await fxPromise,
              body: body as Record<string, unknown>,
              responseBody: result.body,
              usage: result.usage
                ? {
                    estimated: false,
                    inputTokens: result.usage.inputTokens,
                    cachedInputTokens: result.usage.cachedInputTokens,
                    outputTokens: result.usage.outputTokens,
                    ...((result.usage.cacheWriteTokens ?? 0) > 0 ? { cacheWriteTokens: result.usage.cacheWriteTokens } : {}),
                  }
                : { estimated: true, inputTokens: estInput, outputTokens: estimateOutputTokens(result.body, { model: body.model }) },
            });
            const finalized = await signalSucceededWithRetry(deps.billing, ctx, requestId, receipt, noteError);
            if (!finalized) throw new AppError(503, 'finalize_unavailable', '请求已完成但结算暂时不可用，请重试');
            if (result.rawBody) {
              return { status: 200, rawBody: result.rawBody, rawContentType: result.rawContentType ?? 'application/octet-stream' };
            }
            return { status: 200, body: result.body };
          }
          lastError = result.error;
          if (result.error.deadCredential) await markDead(channel.channelId);
          if (!isChannelSwitchable(result.error.code)) {
            // 4xx 客户端错误：退出全部候选（fallback 救不了参数错误——白耗上游调用与预占）
            if ((result.status ?? 0) >= 400 && (result.status ?? 0) < 500) {
              return passthrough4xx({ ...result.error, status: result.status });
            }
            break;
          }
          continue;
        }

        // ---- 流式：first_chunk 前可换渠，上线后终态由事件锚定 ----
        const startedAt = Date.now();
        const { streamResult, decisive } = await withAsyncSpan(tracer, 'upstream.attempt', {
          'request.id': requestId,
          'user.id': auth.userId,
          'channel.key': channel.channelName,
          'channel.attempt': channelAttempt,
          'ai.model': candidate.realModel,
          'upstream.stream': true,
        }, async (span) => {
          const s = await deps.upstream.chatStream(channel, {
            requestId, realModel: candidate.realModel, externalModel: body.model, endpoint, body: upstreamBody,
          });
          const d = await new Promise<UpstreamStreamEvent>((resolve) => {
            let settled = false;
            s.onEvent((event) => {
              if (settled) return;
              if (event.type === 'first_chunk' || event.type === 'failed' || event.type === 'success') {
                settled = true;
                resolve(event);
              }
            });
          });
          span.setAttributes({
            'upstream.event': d.type,
            'upstream.duration_ms': Date.now() - startedAt,
            ...(d.type === 'failed'
              ? {
                  'upstream.ok': false,
                  'upstream.error_code': d.code ?? 'upstream_error',
                  ...(d.status != null ? { 'http.status_code': d.status } : {}),
                  ...(d.deadCredential ? { 'upstream.dead_credential': true } : {}),
                }
              : { 'upstream.ok': true }),
          });
          if (d.type === 'failed') {
            span.setStatus({ code: SpanStatusCode.ERROR, message: d.code ?? 'upstream_error' });
          }
          return { streamResult: s, decisive: d };
        });
        if (decisive.type === 'failed') {
          lastError = decisive;
          if (decisive.deadCredential) await markDead(channel.channelId);
          if (!isChannelSwitchable(decisive.code)) {
            if ((decisive.status ?? 0) >= 400 && (decisive.status ?? 0) < 500) {
              return await passthrough4xx(decisive);
            }
            break;
          }
          continue;
        }
        // 上线（first_chunk 或零块完成）：终态监听收尾，立即把管道交还路由
        // 长流续租（v1 withBillingLifecycle 语义）：租约 = authorizationTtlMs，每 1/3
        // 续一次——超过 TTL 的长流否则会被 recover 按滞留误释放 → 终态冲突 → 漏收。
        // 终态即停；续租次数上限防「终态永不到达」的协议违约泄漏（停后由 recover 兜底回收）。
        let streamAlive = true;
        const renewIntervalMs = Math.max(1_000, Math.floor(deps.config.authorizationTtlMs / 3));
        let renewCount = 0;
        const renewTimer = setInterval(() => {
          if (!streamAlive || renewCount >= 100) return;
          renewCount += 1;
          void deps.billing.signal(ctx, {
            type: 'lease.renewed',
            requestId,
            leaseOwner: 'gateway',
            leaseMs: deps.config.authorizationTtlMs,
          }).catch((error) => noteError(error, `stream lease renew request=${requestId}`));
        }, renewIntervalMs);
        renewTimer.unref?.();
        streamResult.onEvent(async (event) => {
          if (event.type !== 'success') return;
          const durationMs = Date.now() - startedAt;
          const finality = streamReceiptUsage(event, estInput);
          const receipt: UsageReceipt = {
            ...buildReceipt({
              requestId, userId: auth.userId, apiKeyId: auth.apiKeyId, appId: auth.appId ?? null, candidate,
              externalModel: body.model, channelId: channel.channelId, channelKey: channel.channelName,
              durationMs, fx: await fxPromise,
              body: body as Record<string, unknown>,
              usage: finality.usage.estimated
                ? { estimated: true, inputTokens: finality.usage.inputTokens, outputTokens: finality.usage.outputTokens }
                : { estimated: false, inputTokens: finality.usage.inputTokens, cachedInputTokens: finality.usage.cachedInputTokens, outputTokens: finality.usage.outputTokens },
            }),
            ...(finality.estimatedFor !== undefined ? { estimatedFor: finality.estimatedFor } : {}),
            ...(finality.bytesRelayed !== undefined ? { bytesRelayed: finality.bytesRelayed } : {}),
            stream: true,
            streamAborted: finality.streamAborted,
          };
          // 结算 signal 退避重试：重试期间续租不停（streamAlive 保持 true）——
          // 200 已交付的请求不再因一次 DB 抖动被 recover 误释放成免费单；
          // 耗尽才停租约交 recover 兜底（有界损失 + 响亮日志）。
          const finalized = await signalSucceededWithRetry(deps.billing, ctx, requestId, receipt, noteError);
          if (!finalized) {
            noteError(new Error('signal retries exhausted'), `stream finalize giveup request=${requestId}`);
          }
          streamAlive = false;
          clearInterval(renewTimer);
        });
        return { status: 200, stream: streamResult.stream, contentType: 'text/event-stream' };
      }
    }

    return releaseAndFail();
  };
}
