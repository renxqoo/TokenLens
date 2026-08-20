'use server';

import { revalidatePath } from 'next/cache';
import { adminFetch, ApiError } from '@ai-gateway/api-client';

export interface CatalogImportModel {
  externalName: string;
  realModel: string;
  inputPrice: number;
  outputPrice: number;
  cacheInputPrice: number;
  cacheWritePrice: number;
  contextLength?: number | null;
}

/** 一键入库：channel 源建 provider/channel/mappings；reference 源落草稿（审批制） */
export async function importCatalogAction(input: {
  sourceId: string;
  apiKey?: string;
  models: CatalogImportModel[];
}): Promise<{ error?: string }> {
  if (input.models.length === 0) return { error: '至少选择一个模型' };
  if (!/^[a-z0-9-]{1,32}$/.test(input.sourceId)) return { error: '目录源非法' };
  for (const m of input.models) {
    if (!m.externalName.trim() || !m.realModel.trim()) {
      return { error: '对外名与真实模型名不能为空' };
    }
  }
  try {
    await adminFetch('/api/admin/model-catalog/import', {
      method: 'POST',
      body: {
        sourceId: input.sourceId,
        ...(input.apiKey ? { apiKey: input.apiKey } : {}),
        models: input.models.map((m) => ({
          externalName: m.externalName.trim(),
          realModel: m.realModel.trim(),
          inputPrice: m.inputPrice,
          outputPrice: m.outputPrice,
          cacheInputPrice: m.cacheInputPrice,
          cacheWritePrice: m.cacheWritePrice,
          ...(m.contextLength != null ? { contextLength: m.contextLength } : {}),
        })),
      },
    });
    revalidatePath('/dashboard/model-market');
    revalidatePath('/dashboard/models');
    return {};
  } catch (e) {
    return { error: e instanceof ApiError ? e.message : '导入失败' };
  }
}

/** 手动覆盖汇率（冻结基准直到清除；审计 fx.override） */
export async function setFxOverrideAction(rate: string): Promise<{ error?: string }> {
  try {
    await adminFetch('/api/admin/fx/catalog/override', {
      method: 'PUT',
      body: { rate },
    });
    revalidatePath('/dashboard/model-market');
    return {};
  } catch (e) {
    return { error: e instanceof ApiError ? e.message : '覆盖失败' };
  }
}

/** 清除覆盖：回落自动拉取（立即补拉一次） */
export async function clearFxOverrideAction(): Promise<{ error?: string }> {
  try {
    await adminFetch('/api/admin/fx/catalog/override', { method: 'DELETE' });
    revalidatePath('/dashboard/model-market');
    return {};
  } catch (e) {
    return { error: e instanceof ApiError ? e.message : '清除失败' };
  }
}

/** 点差（%）：生效预填汇率 = 基准 ×(1+点差)；覆盖态不叠加 */
export async function setFxBufferAction(bufferPct: string): Promise<{ error?: string }> {
  try {
    await adminFetch('/api/admin/fx/catalog/buffer', {
      method: 'PUT',
      body: { bufferPct },
    });
    revalidatePath('/dashboard/model-market');
    return {};
  } catch (e) {
    return { error: e instanceof ApiError ? e.message : '点差设置失败' };
  }
}

/** 强制刷新汇率（绕过 TTL 直拉 ECB） */
export async function refreshFxAction(force: boolean): Promise<{ error?: string }> {
  try {
    await adminFetch('/api/admin/fx/catalog/refresh', {
      method: 'POST',
      body: { force },
    });
    revalidatePath('/dashboard/model-market');
    return {};
  } catch (e) {
    return { error: e instanceof ApiError ? e.message : '刷新失败' };
  }
}

export interface PriceHistoryEntry {
  action: string;
  createdAt: string;
  adminId: number | null;
  fx: { baseRate: string; effectiveRate: string | null; source: string | null; fetchedAt: string | null } | null;
  catalogPrompt: string | null;
  catalogCompletion: string | null;
  prefillInputCny: string | null;
  submittedInputCny: string;
  submittedOutputCny: string;
}

/** 价格溯源：某对外名的历次目录导入/改价（目录原价 × 汇率 → 预填 → 提交 全链） */
export async function priceHistoryAction(externalName: string): Promise<{ entries?: PriceHistoryEntry[]; error?: string }> {
  if (!externalName.trim()) return { error: '对外名不能为空' };
  try {
    const data = await adminFetch<{ entries: PriceHistoryEntry[] }>(
      `/api/admin/model-catalog/price-history?externalName=${encodeURIComponent(externalName.trim())}`,
    );
    return { entries: data.entries };
  } catch (e) {
    return { error: e instanceof ApiError ? e.message : '查询失败' };
  }
}
