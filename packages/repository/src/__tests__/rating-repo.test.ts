/**
 * rating 仓储正确性（真实 PG）：整卡单查询装载系数快照，global/model/group 三层齐全。
 * 纯函数优先级（model > group > global > '1'）的规则测试在 @ai-gateway/domain。
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { createDb, modelMappings, rateCardCoefficients, rateCards, type Db } from '@ai-gateway/db';
import { createRepositories, type RepoContext } from '../index.js';

const db: Db = createDb(
  process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/ai_gateway',
  { poolMax: 5 },
);
const ctx: RepoContext = {
  db,
  requestId: `rating-repo-${randomUUID().slice(0, 8)}`,
  actor: { kind: 'system' },
  traceParent: null,
};

describe('RatingRepository.loadRateCardCoefficients', () => {
  const repos = createRepositories();
  let cardId = 0;
  let modelMappingId = 0;

  beforeAll(async () => {
    const [card] = await db
      .insert(rateCards)
      .values({ name: `v2rate-${randomUUID().slice(0, 8)}`, status: 0 })
      .returning({ id: rateCards.id });
    cardId = card!.id;
    // scope='model' 行有 FK 到 model_mappings——自建自有映射（不依赖 dev 库种子残留，CI 全新库可跑）
    const [mapping] = await db
      .insert(modelMappings)
      .values({
        externalName: `v2map-${randomUUID().slice(0, 8)}`,
        realModel: 'v2-rating-repo-real',
      })
      .returning({ id: modelMappings.id });
    modelMappingId = mapping!.id;
    await db.insert(rateCardCoefficients).values([
      { rateCardId: cardId, scope: 'global', modelMappingId: null, groupKey: null, coefficient: '2' },
      { rateCardId: cardId, scope: 'model', modelMappingId, groupKey: null, coefficient: '0.5' },
      { rateCardId: cardId, scope: 'group', modelMappingId: null, groupKey: 'v2vip', coefficient: '1.5' },
    ]);
  });

  afterAll(async () => {
    await db.delete(rateCardCoefficients).where(eq(rateCardCoefficients.rateCardId, cardId));
    await db.delete(rateCards).where(eq(rateCards.id, cardId));
    await db.delete(modelMappings).where(eq(modelMappings.id, modelMappingId));
    await db.$client.end().catch(() => {});
  });

  it('整卡单查询装载：global/model/group 三层齐全', async () => {
    const snapshot = await repos.rating.loadRateCardCoefficients(ctx, cardId);
    expect(snapshot).not.toBeNull();
    expect(snapshot!.model[modelMappingId]).toBe('0.5');
    expect(snapshot!.group['v2vip']).toBe('1.5');
    expect(snapshot!.global).toBe('2');
  });

  it('卡不存在 → null', async () => {
    expect(await repos.rating.loadRateCardCoefficients(ctx, 999_999_999)).toBeNull();
  });

  it('停用卡快照携带 status（消费方决定停用语义）', async () => {
    await db.update(rateCards).set({ status: 1 }).where(eq(rateCards.id, cardId));
    const snapshot = await repos.rating.loadRateCardCoefficients(ctx, cardId);
    expect(snapshot?.status).toBe(1);
  });
});
