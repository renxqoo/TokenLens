/**
 * 模型映射仓储：报价候选链解析（外部名 → 在架映射；fallback 链一次批量取）
 * + 管理面 CRUD/绑定全量替换。
 * 渠道选择不在此（channels.models 匹配属路由域）；定价为官方价，用户价=×费率卡系数。
 */
import { and, asc, desc, eq, ilike, inArray, or, sql } from 'drizzle-orm';
import { channels, modelChannels, modelMappings, providers } from '@ai-gateway/db';
import type { RepoContext } from './context.js';
import { escapeLikePattern } from './search.js';

export interface QuoteMappingRow {
  id: number;
  externalName: string;
  realModel: string;
  /** 上下文窗口（token 数；null=未知——公开价格目录展示用） */
  contextLength: number | null;
  inputPrice: string;
  outputPrice: string;
  cacheInputPrice: string;
  cacheWritePrice: string;
  pricingUnit: string;
  unitPrice: string;
  pricingGroup: string | null;
  isFree: boolean;
  fallbackModels: string[] | null;
  billingPolicy: Record<string, unknown> | null;
  /** 可扩展计费配置（策略 + 变体价格表 + 预扣策略；缺省 = flat 走 unitPrice 列） */
  billingConfig: {
    strategy?: string;
    params?: { unitPrice?: string; selector?: string; prices?: Record<string, string> };
    /** 预扣策略（strategy + params 通用形状——domain reservation-strategy 单一真相） */
    reservation?: { strategy?: string; params?: Record<string, unknown> };
  } | null;
}

const QUOTE_COLUMNS = {
  id: modelMappings.id,
  externalName: modelMappings.externalName,
  contextLength: modelMappings.contextLength,
  realModel: modelMappings.realModel,
  inputPrice: modelMappings.inputPrice,
  outputPrice: modelMappings.outputPrice,
  cacheInputPrice: modelMappings.cacheInputPrice,
  cacheWritePrice: modelMappings.cacheWritePrice,
  pricingUnit: modelMappings.pricingUnit,
  unitPrice: modelMappings.unitPrice,
  pricingGroup: modelMappings.pricingGroup,
  isFree: modelMappings.isFree,
  fallbackModels: modelMappings.fallbackModels,
  billingPolicy: modelMappings.billingPolicy,
  billingConfig: modelMappings.billingConfig,
};

/** 管理面映射行（全字段——目录/绑定/价格编辑共用） */
export interface MappingAdminRow {
  id: number;
  externalName: string;
  realModel: string;
  contextLength: number | null;
  status: number;
  inputPrice: string;
  outputPrice: string;
  cacheInputPrice: string;
  cacheWritePrice: string;
  isFree: boolean;
  rpmLimit: number | null;
  tpmLimit: number | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface MappingAdminPatch {
  externalName?: string;
  realModel?: string;
  contextLength?: number | null;
  status?: number;
  inputPrice?: string;
  outputPrice?: string;
  cacheInputPrice?: string;
  cacheWritePrice?: string;
  isFree?: boolean;
  rpmLimit?: number | null;
  tpmLimit?: number | null;
}

const MAPPING_ADMIN_COLUMNS = {
  id: modelMappings.id,
  externalName: modelMappings.externalName,
  realModel: modelMappings.realModel,
  contextLength: modelMappings.contextLength,
  status: modelMappings.status,
  inputPrice: modelMappings.inputPrice,
  outputPrice: modelMappings.outputPrice,
  cacheInputPrice: modelMappings.cacheInputPrice,
  cacheWritePrice: modelMappings.cacheWritePrice,
  isFree: modelMappings.isFree,
  billingPolicy: modelMappings.billingPolicy,
  rpmLimit: modelMappings.rpmLimit,
  tpmLimit: modelMappings.tpmLimit,
  createdAt: modelMappings.createdAt,
  updatedAt: modelMappings.updatedAt,
};

/** 模型映射仓储（无状态；方法统一接收 RepoContext） */
export class ModelMappingRepository {
  /** 单查（鉴权后已知模型名；status=0 在架） */
  async findActiveByExternalName(
    c: RepoContext,
    externalName: string,
  ): Promise<QuoteMappingRow | null> {
    const [row] = await c.db
      .select(QUOTE_COLUMNS)
      .from(modelMappings)
      .where(and(eq(modelMappings.externalName, externalName), eq(modelMappings.status, 0)));
    return (row as QuoteMappingRow) ?? null;
  }

  /** 上架模型目录（/v1/models）：外部名 + 真实名 + 计价单位；按外部名排序 */
  async listEnabledModels(c: RepoContext): Promise<Array<{
    externalName: string;
    realModel: string;
    pricingUnit: string;
  }>> {
    const rows = await c.db
      .select({
        externalName: modelMappings.externalName,
        realModel: modelMappings.realModel,
        pricingUnit: modelMappings.pricingUnit,
      })
      .from(modelMappings)
      .where(eq(modelMappings.status, 0))
      .orderBy(modelMappings.externalName);
    return rows;
  }

  /** 批量查（主模型 + fallback 链一次取；缺名/下架自动缺席，调用方按链序消费） */
  async findActiveByExternalNames(
    c: RepoContext,
    externalNames: readonly string[],
  ): Promise<Map<string, QuoteMappingRow>> {
    if (externalNames.length === 0) return new Map();
    const rows = await c.db
      .select(QUOTE_COLUMNS)
      .from(modelMappings)
      .where(
        and(
          inArray(modelMappings.externalName, [...externalNames]),
          eq(modelMappings.status, 0),
          sql`true`,
        ),
      );
    return new Map(rows.map((row) => [row.externalName, row as QuoteMappingRow]));
  }

  // ── 管理面 CRUD ────────────────────────────────────────────────────────────

  async insertMapping(
    c: RepoContext,
    input: {
      externalName: string;
      realModel: string;
      contextLength?: number | null;
      inputPrice: string;
      outputPrice: string;
      cacheInputPrice: string;
      cacheWritePrice?: string;
      isFree: boolean;
      /** 0 上架 / 1 下架（目录导入用 1 = 草稿态） */
      status?: number;
      billingPolicy?: Record<string, unknown> | null;
      rpmLimit?: number | null;
      tpmLimit?: number | null;
    },
  ): Promise<MappingAdminRow> {
    const [row] = await c.db
      .insert(modelMappings)
      .values({
        externalName: input.externalName,
        realModel: input.realModel,
        contextLength: input.contextLength ?? null,
        status: input.status ?? 0,
        inputPrice: input.inputPrice,
        outputPrice: input.outputPrice,
        cacheInputPrice: input.cacheInputPrice,
        cacheWritePrice: input.cacheWritePrice ?? '0',
        isFree: input.isFree,
        billingPolicy: input.billingPolicy ?? null,
        rpmLimit: input.rpmLimit ?? null,
        tpmLimit: input.tpmLimit ?? null,
      })
      .returning(MAPPING_ADMIN_COLUMNS);
    if (!row) throw new Error('model_mapping.insert_failed');
    return row as MappingAdminRow;
  }

  async findById(c: RepoContext, mappingId: number): Promise<MappingAdminRow | null> {
    const [row] = await c.db
      .select(MAPPING_ADMIN_COLUMNS)
      .from(modelMappings)
      .where(eq(modelMappings.id, mappingId));
    return (row as MappingAdminRow) ?? null;
  }

  async findByExternalName(c: RepoContext, externalName: string): Promise<MappingAdminRow | null> {
    const [row] = await c.db
      .select(MAPPING_ADMIN_COLUMNS)
      .from(modelMappings)
      .where(eq(modelMappings.externalName, externalName));
    return (row as MappingAdminRow) ?? null;
  }

  /** 部分更新（白名单字段；价格字符串由服务层格式化）。0 行 = 不存在 */
  async updateMapping(
    c: RepoContext,
    input: { mappingId: number; patch: MappingAdminPatch },
  ): Promise<MappingAdminRow | null> {
    const rows = await c.db
      .update(modelMappings)
      .set({ ...input.patch, updatedAt: new Date() })
      .where(eq(modelMappings.id, input.mappingId))
      .returning(MAPPING_ADMIN_COLUMNS);
    return (rows[0] as MappingAdminRow) ?? null;
  }

  /** 软下架：status=1 */
  async retireMapping(c: RepoContext, input: { mappingId: number }): Promise<boolean> {
    const rows = await c.db
      .update(modelMappings)
      .set({ status: 1, updatedAt: new Date() })
      .where(eq(modelMappings.id, input.mappingId))
      .returning({ id: modelMappings.id });
    return rows.length > 0;
  }

  /** 统一列表：q 命中 externalName/realModel（字面匹配） */
  async listMappings(
    c: RepoContext,
    input: {
      q?: string;
      sortBy: 'id' | 'externalName' | 'realModel' | 'status' | 'createdAt';
      order: 'asc' | 'desc';
      limit: number;
      offset: number;
    },
  ): Promise<{ rows: MappingAdminRow[]; total: number }> {
    const pattern = input.q ? escapeLikePattern(input.q) : null;
    const where = pattern
      ? or(ilike(modelMappings.externalName, pattern), ilike(modelMappings.realModel, pattern))
      : undefined;
    const sorts = {
      id: modelMappings.id,
      externalName: modelMappings.externalName,
      realModel: modelMappings.realModel,
      status: modelMappings.status,
      createdAt: modelMappings.createdAt,
    } as const;
    const column = sorts[input.sortBy];
    const orderBy = [input.order === 'asc' ? asc(column) : desc(column), desc(modelMappings.id)];
    const [rows, countRows] = await Promise.all([
      c.db
        .select(MAPPING_ADMIN_COLUMNS)
        .from(modelMappings)
        .where(where)
        .orderBy(...orderBy)
        .limit(input.limit)
        .offset(input.offset),
      c.db.select({ count: sql<number>`count(*)::int` }).from(modelMappings).where(where),
    ]);
    return { rows: rows as MappingAdminRow[], total: countRows[0]?.count ?? 0 };
  }

  /** 页内映射的绑定渠道 id（列表回显 channelIds；未绑定 = 缺席，服务层补 []） */
  /** 按渠道查绑定映射（目录「上游消失」检测：绑定到本源渠道且不在目录里的行） */
  async listMappingRowsByChannelId(
    c: RepoContext,
    channelId: number,
  ): Promise<Array<{ mappingId: number; externalName: string; realModel: string }>> {
    return c.db
      .select({
        mappingId: modelChannels.mappingId,
        externalName: modelMappings.externalName,
        realModel: modelMappings.realModel,
      })
      .from(modelChannels)
      .innerJoin(modelMappings, eq(modelChannels.mappingId, modelMappings.id))
      .where(eq(modelChannels.channelId, channelId));
  }

  async listChannelIdsByMappingIds(
    c: RepoContext,
    mappingIds: readonly number[],
  ): Promise<Array<{ mappingId: number; channelId: number }>> {
    if (mappingIds.length === 0) return [];
    return c.db
      .select({ mappingId: modelChannels.mappingId, channelId: modelChannels.channelId })
      .from(modelChannels)
      .where(inArray(modelChannels.mappingId, [...mappingIds]));
  }

  /**
   * 绑定全量替换：删旧插新（同一事务——RepoContext.db 必须是事务句柄）。
   * 空 channels = 解绑全部。返回新绑定数。
   */
  async replaceModelChannels(
    c: RepoContext,
    input: { mappingId: number; channels: Array<{ channelId: number; weight: number; priority: number }> },
  ): Promise<number> {
    await c.db.delete(modelChannels).where(eq(modelChannels.mappingId, input.mappingId));
    if (input.channels.length === 0) return 0;
    await c.db
      .insert(modelChannels)
      .values(input.channels.map((ch) => ({ ...ch, mappingId: input.mappingId })));
    return input.channels.length;
  }

  /** 单映射的绑定渠道连接信息（模型探针 /test 用；含密文——仅服务层解密） */
  async listBoundChannelsForProbe(
    c: RepoContext,
    mappingId: number,
  ): Promise<
    Array<{
      channelId: number;
      channelName: string;
      apiKeyEnc: string;
      baseUrlOverride: string | null;
      providerBaseUrl: string;
      providerProtocol: string;
      providerVendor: string | null;
    }>
  > {
    return c.db
      .select({
        channelId: channels.id,
        channelName: channels.name,
        apiKeyEnc: channels.apiKeyEnc,
        baseUrlOverride: channels.baseUrlOverride,
        providerBaseUrl: providers.baseUrl,
        providerProtocol: providers.protocol,
        providerVendor: providers.vendor,
      })
      .from(modelChannels)
      .innerJoin(channels, eq(modelChannels.channelId, channels.id))
      .innerJoin(providers, eq(channels.providerId, providers.id))
      .where(eq(modelChannels.mappingId, mappingId));
  }

  /** 目录导入幂等绑定：已绑定时不重复插（onConflictDoNothing 复合主键） */
  async ensureModelChannelBinding(
    c: RepoContext,
    input: { mappingId: number; channelId: number },
  ): Promise<void> {
    await c.db
      .insert(modelChannels)
      .values({ mappingId: input.mappingId, channelId: input.channelId, weight: 1, priority: 0 })
      .onConflictDoNothing({ target: [modelChannels.mappingId, modelChannels.channelId] });
  }

  /** 在架映射按真实名批量查（目录对比用：已导入回填卖价） */
  async listEnabledByRealModels(
    c: RepoContext,
    realModels: readonly string[],
  ): Promise<MappingAdminRow[]> {
    if (realModels.length === 0) return [];
    const rows = await c.db
      .select(MAPPING_ADMIN_COLUMNS)
      .from(modelMappings)
      .where(and(inArray(modelMappings.realModel, [...realModels]), eq(modelMappings.status, 0)));
    return rows as MappingAdminRow[];
  }
}
