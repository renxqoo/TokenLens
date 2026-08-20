/**
 * 静默溢出告警接线（P1#4）：success+contextOverflow 事件 → notify_outbox 入箱
 * （dedupe 按请求幂等）；非溢出事件不入箱；入箱为旁路不影响请求路径。
 */
import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { createDb, notifyOutbox } from '@ai-gateway/db';
import { wireContextOverflowAlert } from '../ai/overflow-alert.js';

const db = createDb(process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/ai_gateway', { poolMax: 5 });
afterAll(async () => {
  await db.$client.end().catch(() => {});
});

type FakeEvent = { type: string; requestId?: string; channelKey?: string; contextOverflow?: boolean; model?: string; usage?: { inputTokens?: number } | null };
type Captured = (e: FakeEvent) => void;

function fakeAi(): { onEvent(cb: Captured): () => void; emit(e: Record<string, unknown>): void } {
  let captured: Captured | null = null;
  return {
    onEvent(cb) {
      captured = cb;
      return () => {
        captured = null;
      };
    },
    emit(e: FakeEvent) {
      captured?.(e);
    },
  };
}

describe('wireContextOverflowAlert', () => {
  it('溢出 success 事件 → 入箱（含 model/inputTokens）；同请求重发幂等', async () => {
    const ai = fakeAi();
    const dispose = wireContextOverflowAlert(ai, db);
    const requestId = randomUUID();
    try {
      ai.emit({
        type: 'success',
        requestId,
        channelKey: 'ch-overflow',
        contextOverflow: true,
        model: 'some-model',
        usage: { inputTokens: 999_999 },
      });
      // 入箱是 fire-and-forget——轮询等待落库
      let row: { event: string; dedupeKey: string } | undefined;
      for (let i = 0; i < 20 && !row; i += 1) {
        await new Promise((r) => setTimeout(r, 100));
        [row] = await db.select({ event: notifyOutbox.event, dedupeKey: notifyOutbox.dedupeKey }).from(notifyOutbox).where(eq(notifyOutbox.dedupeKey, `context-overflow:${requestId}`));
      }
      expect(row).toMatchObject({ event: 'context_overflow' });

      // 同请求重发 → onConflictDoNothing 幂等（仍一行）
      ai.emit({ type: 'success', requestId, contextOverflow: true, usage: { inputTokens: 1 } });
      await new Promise((r) => setTimeout(r, 300));
      const rows = await db.select({ id: notifyOutbox.id }).from(notifyOutbox).where(eq(notifyOutbox.dedupeKey, `context-overflow:${requestId}`));
      expect(rows).toHaveLength(1);
      await db.delete(notifyOutbox).where(eq(notifyOutbox.dedupeKey, `context-overflow:${requestId}`));
    } finally {
      dispose();
    }
  });

  it('非溢出/非 success 事件不入箱', async () => {
    const ai = fakeAi();
    const dispose = wireContextOverflowAlert(ai, db);
    try {
      const requestId = randomUUID();
      ai.emit({ type: 'success', requestId, usage: { inputTokens: 10 } });
      ai.emit({ type: 'failed', requestId, contextOverflow: true });
      await new Promise((r) => setTimeout(r, 300));
      const rows = await db.select({ id: notifyOutbox.id }).from(notifyOutbox).where(eq(notifyOutbox.dedupeKey, `context-overflow:${requestId}`));
      expect(rows).toHaveLength(0);
    } finally {
      dispose();
    }
  });
});
