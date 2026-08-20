/**
 * audit_logs 仓储：全局审计列表（管理面审计页）+ 事务内审计写入
 * （资金关键操作——billing 复核等要求审计与业务同事务落库）。
 * 用户维度审计在 user.repo（targetType='user' 定向查询）。
 */
import { and, asc, desc, eq, ilike, or, sql } from 'drizzle-orm';
import { auditLogs } from '@ai-gateway/db';
import type { RepoContext } from './context.js';
import { escapeLikePattern } from './search.js';

export interface AuditLogRow {
  id: number;
  adminId: number | null;
  actor: string;
  action: string;
  targetType: string;
  targetId: string | null;
  detail: unknown;
  createdAt: Date;
}

export class AuditLogRepository {
  /** 目录定价溯源：某对外名历次目录导入/改价的审计行（detail.models 含该名） */
  async listCatalogPriceHistory(
    c: RepoContext,
    input: { externalName: string; limit?: number },
  ): Promise<AuditLogRow[]> {
    return c.db
      .select()
      .from(auditLogs)
      .where(
        and(
          sql`${auditLogs.action} in ('model_catalog.import', 'model_catalog.import_draft')`,
          sql`${auditLogs.detail} -> 'models' @> ${JSON.stringify([{ externalName: input.externalName }])}::jsonb`,
        ),
      )
      .orderBy(desc(auditLogs.id))
      .limit(input.limit ?? 50);
  }

  /** 全局审计列表：q 命中 action/targetType/targetId */
  async list(
    c: RepoContext,
    input: { q?: string; sortBy: 'id' | 'action' | 'createdAt'; order: 'asc' | 'desc'; limit: number; offset: number },
  ): Promise<{ rows: AuditLogRow[]; total: number }> {
    const where = input.q
      ? or(
          ilike(auditLogs.action, escapeLikePattern(input.q)),
          ilike(auditLogs.targetType, escapeLikePattern(input.q)),
          ilike(auditLogs.targetId, escapeLikePattern(input.q)),
        )
      : undefined;
    const sorts = { id: auditLogs.id, action: auditLogs.action, createdAt: auditLogs.createdAt } as const;
    const column = sorts[input.sortBy];
    const orderBy = [input.order === 'asc' ? asc(column) : desc(column), desc(auditLogs.id)];
    const [rows, countRows] = await Promise.all([
      c.db
        .select({
          id: auditLogs.id,
          adminId: auditLogs.adminId,
          actor: auditLogs.actor,
          action: auditLogs.action,
          targetType: auditLogs.targetType,
          targetId: auditLogs.targetId,
          detail: auditLogs.detail,
          createdAt: auditLogs.createdAt,
        })
        .from(auditLogs)
        .where(where)
        .orderBy(...orderBy)
        .limit(input.limit)
        .offset(input.offset),
      c.db.select({ count: sql<number>`count(*)::int` }).from(auditLogs).where(where),
    ]);
    return { rows: rows as AuditLogRow[], total: countRows[0]?.count ?? 0 };
  }

  /** 事务内审计写入（资金关键操作——失败即随业务回滚，不吞） */
  async insert(
    c: RepoContext,
    input: {
      adminId: number | null;
      actor: string;
      action: string;
      targetType: string;
      targetId?: string | null;
      detail?: Record<string, unknown> | null;
    },
  ): Promise<void> {
    await c.db.insert(auditLogs).values({
      adminId: input.adminId,
      actor: input.actor,
      action: input.action,
      targetType: input.targetType,
      targetId: input.targetId ?? null,
      detail: input.detail ?? null,
    });
  }

  /** 定向审计查询（billing 复核下钻：targetType+targetId） */
  async listByTarget(
    c: RepoContext,
    input: { targetType: string; targetId: string; limit: number; offset: number },
  ): Promise<AuditLogRow[]> {
    const rows = await c.db
      .select({
        id: auditLogs.id,
        adminId: auditLogs.adminId,
        actor: auditLogs.actor,
        action: auditLogs.action,
        targetType: auditLogs.targetType,
        targetId: auditLogs.targetId,
        detail: auditLogs.detail,
        createdAt: auditLogs.createdAt,
      })
      .from(auditLogs)
      .where(and(eq(auditLogs.targetType, input.targetType), eq(auditLogs.targetId, input.targetId)))
      .orderBy(desc(auditLogs.id))
      .limit(input.limit)
      .offset(input.offset);
    return rows as AuditLogRow[];
  }
}
