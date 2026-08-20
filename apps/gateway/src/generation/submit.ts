/**
 * 生成任务提交编排（app 层，run-chat 的任务族形态）：报价 → 预扣（authorize，
 * 含预扣策略）→ 候选 × 渠道调度 → task_poll 族提交上游 / task_execute 族只登记
 * → 任务行落库（收据模板 + 计量快照）→ 起租约（覆盖任务 TTL）→ 201。
 *
 * 失败语义：可换渠道错误 → 换渠重试；全败 → request.failed 三路归还 → 502；
 * 任务行落库失败 → 503 且预留保留（租约到期由 recover 释放，禁止误退款——
 * 上游任务可能已提交）；资金不足/模型缺失沿用 authorize/quote 的错误翻译。
 */
import { createRepositories, type Db, type Repositories } from '@ai-gateway/repository';
import { estimateMaxCost, generationKindDescriptor, type GenerationTaskKind } from '@ai-gateway/domain';
import type { BillingDomain } from '@ai-gateway/service';
import type { RunContext } from '@ai-gateway/service';
import { buildReceipt } from '../pipeline/receipt.js';
import { admitKey, tryChannel, type RateLimitGate } from '../rate-limit/gate.js';
import type { createBuildQuote } from '../quote/build-quote.js';

type BuildQuote = ReturnType<typeof createBuildQuote>;
import type { createResolveChannels } from '../routing/resolve-channels.js';
import type { GenerationTaskPort } from '@ai-gateway/service';
import { AppError } from '../http/error-map.js';
import { sanitizeUpstreamDetail } from '../http/sanitize.js';
import { isChannelSwitchable } from '../routing/switchable.js';

type ResolveChannels = ReturnType<typeof createResolveChannels>;

export interface SubmitGenerationConfig {
  /** 任务 TTL（超时上界 + 收据租约基线） */
  taskTtlMs: number;
  /** 租约宽限（TTL 之外的安全垫——轮询续租同锚点） */
  leaseGraceMs: number;
  /** 单请求预扣上限（authorize 上限闸——任务族金额=单价×秒，无 token 未知量） */
  reservationLimit: string;
  /** 每用户在途任务上限（预扣+轮询批次的资源闸；缺省不设限——兼容旧行为） */
  maxActivePerUser?: number;
}

export interface SubmitGenerationDeps {
  db: Db;
  billing: BillingDomain;
  buildQuote: BuildQuote;
  resolveChannels: ResolveChannels;
  taskPort: GenerationTaskPort;
  config: SubmitGenerationConfig;
  /** 限流闸（Redis 装配注入；任务族只做 key/渠道 RPM 准入——TPM 是 token 维） */
  rateLimit?: RateLimitGate;
  repos?: Repositories;
  /** 死凭据落库失败只记日志不阻塞提交 */
  onError?: (error: unknown, context: string) => void;
}

export interface SubmitGenerationResult {
  status: 201;
  body: {
    id: string;
    object: GenerationTaskKind;
    model: string;
    task_id?: string;
    status: 'queued';
  };
}

export function createSubmitGeneration(deps: SubmitGenerationDeps) {
  const repos = deps.repos ?? createRepositories();
  const noteError = deps.onError ?? ((error, context) => console.error(`[generation] ${context}:`, error));

  return async function submitGeneration(
    ctx: RunContext,
    auth: { userId: number; apiKeyId: number; appId?: number | null; allowedModels?: string[] | null; rpmLimit?: number | null; tpmLimit?: number | null; userRpmLimit?: number | null; userTpmLimit?: number | null },
    kind: GenerationTaskKind,
    body: Record<string, unknown>,
  ): Promise<SubmitGenerationResult> {
    const requestId = ctx.requestId;
    const descriptor = generationKindDescriptor(kind);
    if (descriptor == null) throw new AppError(404, 'not_found', `未知生成类型 ${kind}`);
    const externalModel = String(body.model ?? '');
    // 模型白名单（App JWT scope.models）——与 chat 管线同口径
    if (auth.allowedModels != null && !auth.allowedModels.includes(externalModel)) {
      throw new AppError(403, 'model_not_allowed', `模型 ${externalModel} 不在该凭证的授权范围内`);
    }
    const startedAt = Date.now();

    // 每用户在途任务上限（TTL 长达小时级——无闸用户可无限堆任务占满预扣与轮询容量）
    if (deps.config.maxActivePerUser != null) {
      const active = await repos.generationTask.countActiveByUser(
        { ...ctx, db: deps.db },
        auth.userId,
      );
      if (active >= deps.config.maxActivePerUser) {
        throw new AppError(429, 'generation_task_limit', '在途生成任务过多，请等待完成后再提交');
      }
    }

    // key 维 RPM 准入（低频任务族不做 TPM 预占——单位计费无 token 量）；
    // 用户维无条件在列——App-JWT 大 scope 不得绕过管理端用户帽（与 run-chat 同口径）
    if (deps.rateLimit) {
      const credentialDimension =
        auth.apiKeyId != null ? `key:${auth.apiKeyId}` : auth.appId != null ? `app:${auth.appId}` : `pg:${auth.userId}`;
      await admitKey(deps.rateLimit, {
        requestId,
        estimatedTokens: 0,
        dims: [
          {
            dimension: credentialDimension,
            rpmLimit: auth.rpmLimit ?? null,
            tpmLimit: null,
          },
          {
            dimension: `user:${auth.userId}`,
            rpmLimit: auth.userRpmLimit ?? null,
            tpmLimit: null,
          },
        ],
      });
    }

    // ---- 报价与预扣（单位轴经计量注册表：video=duration 秒 / music=次；token 轴 0）----
    const quote = await deps.buildQuote(ctx, {
      model: externalModel,
      userId: auth.userId,
      inputTokenUpperBound: 0,
      maxOutputTokens: 0,
      body,
    });
    await deps.billing.authorize(ctx, {
      requestId,
      userId: auth.userId,
      apiKeyId: auth.apiKeyId,
      appId: auth.appId ?? null,
      stream: false,
      quote,
      reservationLimit: deps.config.reservationLimit,
      authorizationTtlMs: deps.config.taskTtlMs + deps.config.leaseGraceMs,
    });

    let leaseStarted = false;
    let lastError = { code: 'upstream_error', message: '无可用渠道' };
    const ensureLease = async (): Promise<void> => {
      if (leaseStarted) return;
      await deps.billing.signal(ctx, {
        type: 'upstream.started',
        requestId,
        leaseOwner: requestId,
        leaseMs: deps.config.taskTtlMs + deps.config.leaseGraceMs,
      });
      leaseStarted = true;
    };

    /** 任务行落库（收据模板除 units 外全部定型；快照即 worker 终态结算依据） */
    const persist = async (
      candidate: (typeof quote.candidates)[number],
      channelId: number,
      channelName: string,
      upstreamTaskId: string | null,
    ): Promise<SubmitGenerationResult> => {
      const snapshot = descriptor.snapshotParams(body);
      const receipt = buildReceipt({
        requestId, userId: auth.userId, apiKeyId: auth.apiKeyId, appId: auth.appId ?? null, candidate,
        externalModel, channelId, channelKey: channelName,
        durationMs: Date.now() - startedAt,
        fx: await repos.fx.current({ ...ctx, db: deps.db }),
        body,
        usage: { estimated: false, inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 },
      });
      try {
        await repos.generationTask.insert({ ...ctx, db: deps.db }, {
          id: requestId,
          requestId,
          userId: auth.userId,
          apiKeyId: auth.apiKeyId,
          mappingId: candidate.mappingId,
          channelId,
          upstreamTaskId,
          kind,
          params: snapshot,
          receiptTemplate: receipt as unknown as Record<string, unknown>,
          unitsSnapshot: String(receipt.usage.units ?? 1),
          expiresAt: new Date(Date.now() + deps.config.taskTtlMs),
          now: new Date(),
        });
      } catch (error) {
        noteError(error, `task persistence failed request=${requestId}`);
        // 预留保留（租约恢复链释放），可重试错误——上游任务可能已提交，禁止误退款
        throw new AppError(503, 'billing_receipt_unavailable', '任务登记暂时无法持久化，请稍后重试');
      }
      return {
        status: 201,
        body: {
          id: requestId,
          object: kind,
          model: externalModel,
          ...(upstreamTaskId !== null ? { task_id: upstreamTaskId } : {}),
          status: 'queued',
        },
      };
    };

    // ---- 候选 × 渠道（与 run-chat 同基序；全败 502 + 三路归还）----
    for (const candidate of quote.candidates) {
      const channels = await deps.resolveChannels(ctx, candidate.realModel);
      const upstreamEstimate = estimateMaxCost({
        estimatedInputTokens: 0,
        maxOutputTokens: 0,
        inputPrice: candidate.inputPrice,
        cacheInputPrice: candidate.cacheInputPrice,
        cacheWritePrice: candidate.cacheWritePrice,
        outputPrice: candidate.outputPrice,
        unitPrice: candidate.unitPrice ?? 0,
        unitUpperBound: candidate.unitUpperBound ?? 0,
        coefficient: '1',
      }).toString();

      for (const channel of channels) {
        if (deps.rateLimit && !(await tryChannel(deps.rateLimit, {
          requestId,
          channelId: channel.channelId,
          rpmLimit: channel.rpmLimit,
          tpmLimit: channel.tpmLimit,
          estimatedTokens: 0,
        }))) {
          lastError = { code: 'rate_limit_exceeded', message: '渠道限流' };
          continue;
        }
        const reservation = await deps.billing.reserveChannel(ctx, {
          requestId, channelId: channel.channelId, amount: upstreamEstimate,
        });
        if (!reservation.allowed) {
          lastError = { code: 'channel_budget_exhausted', message: '渠道预算不足' };
          continue;
        }
        await ensureLease();

        // task_execute 族（music）：网关不调上游，worker 代执行
        if (descriptor.execution === 'task_execute') {
          return await persist(candidate, channel.channelId, channel.channelName, null);
        }
        // task_poll 族（video）：提交上游换任务号
        const submitted = await deps.taskPort.submitTask(channel, {
          requestId, realModel: candidate.realModel, externalModel, kind, body,
        });
        if (submitted.ok) {
          return await persist(candidate, channel.channelId, channel.channelName, submitted.upstreamTaskId);
        }
        lastError = { code: submitted.error.code ?? 'upstream_error', message: submitted.error.message ?? '提交失败' };
        if (submitted.error.deadCredential) {
          try {
            await deps.db.transaction((tx) => repos.channel.markDeadCredential({ ...ctx, db: tx }, channel.channelId));
          } catch (error) {
            noteError(error, `mark dead credential channel=${channel.channelId}`);
          }
        }
        if (!isChannelSwitchable(submitted.error.code)) break;
      }
    }

    // 全败：三路归还（账单 released、钱包在途归零、渠道敞口归还）；message 脱敏
    await deps.billing.signal(ctx, {
      type: 'request.failed', requestId, reason: `generation_submit_failed:${lastError.code}`.slice(0, 64),
    });
    throw new AppError(502, lastError.code ?? 'upstream_error', sanitizeUpstreamDetail(lastError.message, {
      externalModel,
      realModels: quote.candidates.map((candidate) => candidate.realModel),
    }));
  };
}
