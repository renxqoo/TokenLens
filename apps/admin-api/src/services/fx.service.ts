/**
 * 目录汇率服务（写路径唯一入口）：自动拉取（ECB/frankfurter，无 key）+
 * 手动覆盖 + 点差。真相在 fx_rates 追加表与审计；system_configs 只是运行态缓存。
 * 表/配置读写全走 repository（零 SQL 分层）。
 *
 * 生效语义（对账口径）：
 *   基准汇率 base     = override（最近 manual 行）?? 最近 auto 行
 *   预填换算 effective = base ×(1 + bufferPct/100)   ← 点差不叠在覆盖值上（手动值自带运营判断）
 *   usage_logs.fx_rate 落的是 base（市场真相）；点差只进导入 provenance
 */
import { Decimal } from '@ai-gateway/domain';
import { recordAudit } from '@ai-gateway/http';
import { createRepositories, type Db, type Repositories } from '@ai-gateway/repository';
import type { RunContext } from '@ai-gateway/service';
import { AppError } from '../http/error-map.js';

export const FX_SOURCE_ECB = 'https://api.frankfurter.app/latest?from=USD&to=CNY';
/** auto 行拉取节奏：ECB 每工作日一发，4h 懒检查足够新鲜 */
export const FX_AUTO_TTL_MS = 4 * 60 * 60 * 1000;
const RATE_MIN = 0.01;
const RATE_MAX = 1000;
const BUFFER_PCT_MAX = 50;

type FxConfig = {
  mode: 'auto' | 'override';
  bufferPct: string;
  overrideRate: string | null;
  currentRate: string | null;
  currentFxRateId: number | null;
  source: string | null;
  fetchedAt: string | null;
};

const EMPTY_CONFIG: FxConfig = {
  mode: 'auto',
  bufferPct: '0',
  overrideRate: null,
  currentRate: null,
  currentFxRateId: null,
  source: null,
  fetchedAt: null,
};

export interface FxState {
  mode: 'auto' | 'override';
  /** 基准（1 USD = ? CNY；请求收据快照的是它） */
  baseRate: string | null;
  /** 预填换算用生效汇率 = base ×(1+buffer/100)；base 缺失时 null（UI 只展示目录原价） */
  effectiveRate: string | null;
  bufferPct: string;
  source: string | null;
  fxRateId: number | null;
  fetchedAt: string | null;
}

export interface FxService {
  state(ctx: RunContext): Promise<FxState>;
  /** force=false 尊重 TTL（新鲜即跳过）；force=true 无条件拉 */
  refresh(ctx: RunContext, input: { adminId: number; force?: boolean }): Promise<FxState>;
  /** 手动覆盖（冻结基准直到 clearOverride） */
  setOverride(ctx: RunContext, input: { adminId: number; rate: string }): Promise<FxState>;
  clearOverride(ctx: RunContext, input: { adminId: number }): Promise<FxState>;
  setBuffer(ctx: RunContext, input: { adminId: number; bufferPct: string }): Promise<FxState>;
}

function normalizeRate(raw: string): string {
  const n = Number(raw);
  if (!Number.isFinite(n) || n < RATE_MIN || n > RATE_MAX) {
    throw new AppError(400, 'invalid_fx_rate', `汇率须在 ${RATE_MIN}~${RATE_MAX} 之间`);
  }
  return String(n);
}

function normalizeBuffer(raw: string): string {
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0 || n > BUFFER_PCT_MAX) {
    throw new AppError(400, 'invalid_fx_buffer', `点差须在 0~${BUFFER_PCT_MAX}% 之间`);
  }
  return String(n);
}

/** 生效汇率 = base ×(1+buffer/100)（Decimal；预填展示用） */
export function applyBuffer(base: string, bufferPct: string): string {
  return new Decimal(base)
    .times(new Decimal(1).plus(new Decimal(bufferPct).div(100)))
    .toString();
}

export function createFxService(deps: { db: Db; repos?: Repositories; fetchImpl?: typeof fetch }): FxService {
  const { db } = deps;
  const repos = deps.repos ?? createRepositories();
  const doFetch = deps.fetchImpl ?? fetch;

  async function readConfig(ctx: RunContext): Promise<FxConfig> {
    const row = await repos.fx.readConfig({ db, ...ctx });
    return { ...EMPTY_CONFIG, ...((row ?? {}) as Partial<FxConfig>) };
  }

  async function writeConfig(ctx: RunContext, next: Partial<FxConfig>, adminId: number | null): Promise<void> {
    const merged = { ...(await readConfig(ctx)), ...next };
    await repos.fx.upsertConfig({ db, ...ctx }, { value: merged, adminId });
  }

  async function currentState(ctx: RunContext): Promise<FxState> {
    const config = await readConfig(ctx);
    const current = await repos.fx.current({ db, ...ctx }, { force: true });
    const base = current?.rate ?? null;
    const effective =
      base == null || config.mode === 'override' ? base : applyBuffer(base, config.bufferPct);
    return {
      mode: config.mode,
      baseRate: base,
      effectiveRate: effective,
      bufferPct: config.bufferPct,
      source: current?.source ?? null,
      fxRateId: current?.fxRateId ?? null,
      fetchedAt: current?.fetchedAt ?? null,
    };
  }

  async function fetchEcbRate(): Promise<string> {
    const res = await doFetch(FX_SOURCE_ECB, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) throw new AppError(502, 'fx_fetch_failed', `汇率源返回 ${res.status}`);
    const j = (await res.json()) as { rates?: { CNY?: unknown } };
    return normalizeRate(String(j.rates?.CNY ?? ''));
  }

  async function doRefresh(ctx: RunContext, force: boolean, adminId: number | null): Promise<void> {
    if (!force) {
      const config = await readConfig(ctx);
      const fresh =
        config.fetchedAt != null && Date.now() - Date.parse(config.fetchedAt) < FX_AUTO_TTL_MS;
      if (fresh) return;
    }
    const rate = await fetchEcbRate();
    const row = await repos.fx.insertRate({ db, ...ctx }, { rate, source: 'ecb', mode: 'auto' });
    await writeConfig(
      ctx,
      {
        currentRate: rate,
        currentFxRateId: row.id,
        source: 'ecb',
        fetchedAt: new Date().toISOString(),
      },
      adminId,
    );
  }

  return {
    async state(ctx) {
      // 懒拉（auto 态）：表里没有可用行（真相在 fx_rates，配置缓存可能失真）或时间过期才拉；
      // 失败降级返回现状——绝不阻塞目录浏览
      const current = await repos.fx.current({ db, ...ctx }, { force: true });
      const config = await readConfig(ctx);
      const staleByTime =
        config.fetchedAt == null || Date.now() - Date.parse(config.fetchedAt) > FX_AUTO_TTL_MS;
      if (config.mode === 'auto' && (current == null || staleByTime)) {
        try {
          await doRefresh(ctx, current == null, null);
        } catch {
          // 拉取失败容忍：currentState 显示 null，UI 标注汇率不可用
        }
      }
      return currentState(ctx);
    },

    async refresh(ctx, input) {
      await doRefresh(ctx, input.force === true, input.adminId);
      return currentState(ctx);
    },

    async setOverride(ctx, input) {
      const rate = normalizeRate(input.rate);
      const row = await repos.fx.insertRate(
        { db, ...ctx },
        { rate, source: 'manual', mode: 'override', operatorAdminId: input.adminId },
      );
      await writeConfig(
        ctx,
        {
          mode: 'override',
          overrideRate: rate,
          currentRate: rate,
          currentFxRateId: row.id,
          source: 'manual',
          fetchedAt: new Date().toISOString(),
        },
        input.adminId,
      );
      await recordAudit(db, {
        actor: 'admin',
        adminId: input.adminId,
        action: 'fx.override',
        targetType: 'system_config',
        targetId: 'catalog_fx',
        detail: { rate, fxRateId: row.id },
      });
      return currentState(ctx);
    },

    async clearOverride(ctx, input) {
      await writeConfig(
        ctx,
        {
          mode: 'auto',
          overrideRate: null,
          currentRate: null,
          currentFxRateId: null,
          source: null,
          fetchedAt: null,
        },
        input.adminId,
      );
      await recordAudit(db, {
        actor: 'admin',
        adminId: input.adminId,
        action: 'fx.override_clear',
        targetType: 'system_config',
        targetId: 'catalog_fx',
        detail: {},
      });
      // 清除后立即补一次 auto 行，避免空窗（失败容忍）
      try {
        await doRefresh(ctx, true, null);
      } catch {
        // 同上：UI 提示汇率不可用
      }
      return currentState(ctx);
    },

    async setBuffer(ctx, input) {
      const bufferPct = normalizeBuffer(input.bufferPct);
      await writeConfig(ctx, { bufferPct }, input.adminId);
      await recordAudit(db, {
        actor: 'admin',
        adminId: input.adminId,
        action: 'fx.buffer',
        targetType: 'system_config',
        targetId: 'catalog_fx',
        detail: { bufferPct },
      });
      return currentState(ctx);
    },
  };
}
