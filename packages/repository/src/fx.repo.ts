/**
 * 汇率仓储：当前生效汇率读取（网关收据快照与目录导入共用的单一真相）。
 * 写路径（自动拉取/手动覆盖/点差）只在 admin-api fx 服务——本仓储只读。
 * 热路径消费方（网关每请求）应叠加进程内 TTL 缓存（FX_CACHE_MS）。
 */
import { desc, eq, and } from 'drizzle-orm';
import { fxRates, systemConfigs } from '@ai-gateway/db';
import type { RepoContext } from './context.js';

export const CATALOG_FX_CONFIG_KEY = 'catalog_fx';
/** 进程内缓存 TTL：拉取动作本身在 admin-api 懒触发，这里只防每请求打表 */
export const FX_CACHE_MS = 60_000;

export interface FxCurrent {
  /** 基准市场汇率（1 USD = ? CNY；不含点差——点差是定价决策，只进导入 provenance） */
  rate: string;
  /** fx_rates 追加表行 id（来源/时间/操作人真相） */
  fxRateId: number;
  source: string;
  fetchedAt: string;
}

interface FxConfigShape {
  mode: 'auto' | 'override';
  bufferPct: string;
  overrideRate: string | null;
  currentRate: string | null;
  currentFxRateId: number | null;
  source: string | null;
  fetchedAt: string | null;
}

/** numeric 列尾零规范化（快照形态稳定） */
function trimNumeric(value: string): string {
  if (!value.includes('.')) return value;
  return value.replace(/0+$/, '').replace(/\.$/, '');
}

export class FxRepository {
  private cache: { at: number; value: FxCurrent | null } | null = null;

  /**
   * 当前生效基准汇率（override 优先，回落最近 auto 行；无任何行 = null，消费方降级）。
   * 配置缓存行与 fx_rates 行不一致时以 fx_rates 追加表为准（真相在追加表）。
   */
  async current(c: RepoContext, opts: { force?: boolean } = {}): Promise<FxCurrent | null> {
    if (!opts.force && this.cache && Date.now() - this.cache.at < FX_CACHE_MS) {
      return this.cache.value;
    }
    const value = await this.loadCurrent(c);
    this.cache = { at: Date.now(), value };
    return value;
  }

  private async loadCurrent(c: RepoContext): Promise<FxCurrent | null> {
    const config = await c.db.query.systemConfigs.findFirst({
      where: eq(systemConfigs.key, CATALOG_FX_CONFIG_KEY),
      columns: { value: true },
    });
    const shape = (config?.value ?? null) as FxConfigShape | null;
    if (shape?.mode === 'override' && shape.overrideRate != null) {
      const manual = await c.db.query.fxRates.findFirst({
        where: and(eq(fxRates.mode, 'override')),
        orderBy: [desc(fxRates.id)],
        columns: { id: true, rate: true, fetchedAt: true },
      });
      // 覆盖态以追加表最近 manual 行为准（配置只是缓存视图）
      if (manual) {
        return {
          rate: trimNumeric(manual.rate),
          fxRateId: manual.id,
          source: 'manual',
          fetchedAt: manual.fetchedAt.toISOString(),
        };
      }
    }
    const latest = await c.db.query.fxRates.findFirst({
      where: eq(fxRates.mode, 'auto'),
      orderBy: [desc(fxRates.id)],
      columns: { id: true, rate: true, source: true, fetchedAt: true },
    });
    if (!latest) return null;
    return {
      rate: trimNumeric(latest.rate),
      fxRateId: latest.id,
      source: latest.source,
      fetchedAt: latest.fetchedAt.toISOString(),
    };
  }

  /** 追加一行汇率（fx_rates 只增不改——auto 拉取与 manual 覆盖共用） */
  async insertRate(
    c: RepoContext,
    input: { rate: string; source: string; mode: 'auto' | 'override'; operatorAdminId?: number | null },
  ): Promise<{ id: number }> {
    const [row] = await c.db
      .insert(fxRates)
      .values({
        rate: input.rate,
        source: input.source,
        mode: input.mode,
        operatorAdminId: input.operatorAdminId ?? null,
      })
      .returning({ id: fxRates.id });
    return { id: row!.id };
  }

  /** catalog_fx 配置读（缓存视图；真相在 fx_rates 与审计） */
  async readConfig(c: RepoContext): Promise<Record<string, unknown> | null> {
    const row = await c.db.query.systemConfigs.findFirst({
      where: eq(systemConfigs.key, CATALOG_FX_CONFIG_KEY),
      columns: { value: true },
    });
    return (row?.value as Record<string, unknown> | undefined) ?? null;
  }

  /** catalog_fx 配置写（upsert；merged 由调用方算好） */
  async upsertConfig(
    c: RepoContext,
    input: { value: Record<string, unknown>; adminId: number | null },
  ): Promise<void> {
    await c.db
      .insert(systemConfigs)
      .values({ key: CATALOG_FX_CONFIG_KEY, value: input.value, updatedByAdminId: input.adminId })
      .onConflictDoUpdate({
        target: systemConfigs.key,
        set: { value: input.value, updatedAt: new Date(), updatedByAdminId: input.adminId },
      });
  }

  /** 点差（%）：预填价 = 目录美元价 × 基准 ×(1+buffer/100)；未配置 = 0 */
  async bufferPct(c: RepoContext): Promise<string> {
    const config = await c.db.query.systemConfigs.findFirst({
      where: eq(systemConfigs.key, CATALOG_FX_CONFIG_KEY),
      columns: { value: true },
    });
    const shape = (config?.value ?? null) as FxConfigShape | null;
    return shape?.bufferPct ?? '0';
  }
}
