'use server';

import { revalidatePath } from 'next/cache';

import { adminFetch, ApiError } from '@ai-gateway/api-client';

// ── 创建模型映射 ────────────────────────────────────────────────────────────
export interface ModelCreateInput {
  externalName: string;
  realModel: string;
  inputPrice: number;
  outputPrice: number;
  cacheInputPrice?: number;
  cacheWritePrice?: number;
  isFree?: boolean;
  contextLength?: number | null;
  billingPolicy?: Record<string, unknown> | null;
}

export async function createModelAction(input: ModelCreateInput): Promise<{ error?: string }> {
  if (!input.externalName.trim() || !input.realModel.trim()) {
    return { error: '名称不能为空' };
  }
  try {
    await adminFetch('/api/admin/models', {
      method: 'POST',
      body: {
        externalName: input.externalName.trim(),
        realModel: input.realModel.trim(),
        inputPrice: input.inputPrice,
        outputPrice: input.outputPrice,
        cacheInputPrice: input.cacheInputPrice ?? 0,
        ...(input.cacheWritePrice != null ? { cacheWritePrice: input.cacheWritePrice } : {}),
        isFree: input.isFree ?? false,
        ...(input.contextLength != null ? { contextLength: input.contextLength } : {}),
        billingPolicy: input.billingPolicy ?? null,
      },
    });
    revalidatePath('/dashboard/models');
    return {};
  } catch (e) {
    return { error: e instanceof ApiError ? e.message : '创建失败' };
  }
}

// ── 编辑模型映射 ────────────────────────────────────────────────────────────
export interface ModelUpdateInput {
  externalName?: string;
  realModel?: string;
  inputPrice?: number;
  outputPrice?: number;
  cacheInputPrice?: number;
  cacheWritePrice?: number;
  isFree?: boolean;
  contextLength?: number | null;
  fallbackModels?: string;
  paramRules?: string;
  billingPolicy?: Record<string, unknown> | null;
  rpmLimit?: number | null;
  tpmLimit?: number | null;
  status?: number;
}

export async function updateModelAction(
  id: number,
  input: ModelUpdateInput,
): Promise<{ error?: string }> {
  try {
    await adminFetch(`/api/admin/models/${id}`, { method: 'PATCH', body: input });
    revalidatePath('/dashboard/models');
    return {};
  } catch (e) {
    return { error: e instanceof ApiError ? e.message : '保存失败' };
  }
}

// ── 删除模型映射 ────────────────────────────────────────────────────────────
export async function deleteModelAction(id: number): Promise<{ error?: string }> {
  try {
    await adminFetch(`/api/admin/models/${id}`, { method: 'DELETE' });
    revalidatePath('/dashboard/models');
    return {};
  } catch (e) {
    return { error: e instanceof ApiError ? e.message : '删除失败' };
  }
}

// ── 绑定渠道 ────────────────────────────────────────────────────────────────
export async function bindChannelsAction(
  id: number,
  channelIds: number[],
): Promise<{ error?: string }> {
  try {
    await adminFetch(`/api/admin/models/${id}/channels`, {
      method: 'POST',
      // 标准契约（与 admin-api models.ts 的 bindChannelsSchema 一致）：
      // { channels: [{channelId, weight?, priority?}] }，全量替换语义
      body: { channels: channelIds.map((channelId) => ({ channelId })) },
    });
    revalidatePath('/dashboard/models');
    return {};
  } catch (e) {
    return { error: e instanceof ApiError ? e.message : '绑定失败' };
  }
}

// ── 模型级测试（最小生成探针：逐绑定渠道真实生成 "1" + max_tokens 1） ────────
export interface ModelTestResult {
  channelId: number;
  channel: string;
  ok: boolean;
  durationMs: number;
  tokens?: number;
  error?: { code: string; message: string };
}

export async function testModelAction(id: number): Promise<
  { results?: ModelTestResult[]; error?: string }
> {
  try {
    const data = await adminFetch<{ results: ModelTestResult[] }>(
      `/api/admin/models/${id}/test`,
      { method: 'POST' },
    );
    return { results: data.results };
  } catch (e) {
    return { error: e instanceof ApiError ? e.message : '测试失败' };
  }
}
