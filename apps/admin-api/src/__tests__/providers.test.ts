/**
 * 供应商语义（v1 providers-protocol + admin-routes-batch providers 部分的 v2 对位）：
 * 协议词表单一真相（非法协议 400 且不触库）/ 重名 409（PG 翻译）/
 * baseUrl 形状 / 长度上界 / 软退役 404 族 / 排序白名单。
 */
import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { providers as providersTable } from '@ai-gateway/db';
import { buildTestApp, db, newAdmin, uid } from './helpers.js';

describe('供应商协议词表（单一真相 = ai 适配器注册表）', () => {
  it.each(['openai', 'openai_compatible', 'made-up'])('非法协议 %s → 400 且不触库', async (protocol) => {
    const { request } = buildTestApp();
    const { token } = await newAdmin();
    const res = await request('/v1/providers', {
      token,
      body: { name: uid('p'), protocol, baseUrl: 'https://api.example.com/v1' },
    });
    expect(res.status).toBe(400);
  });

  it('PATCH 非法协议 → 400（校验在 zod/service 层先行——id 不存在也不 404）', async () => {
    const { request } = buildTestApp();
    const { token } = await newAdmin();
    const res = await request('/v1/providers/999999999', {
      method: 'PATCH',
      token,
      body: { protocol: 'openai' },
    });
    expect(res.status).toBe(400);
  });

  it('合法协议 openai-compatible → 201 且原样入库（无运行时翻译）', async () => {
    const { request } = buildTestApp();
    const { token } = await newAdmin();
    const name = uid('p');
    const res = await request('/v1/providers', {
      token,
      body: { name, protocol: 'openai-compatible', baseUrl: 'https://api.example.com/v1' },
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { protocol: string };
    expect(body.protocol).toBe('openai-compatible');
    const [row] = await db.select().from(providersTable).where(eq(providersTable.name, name));
    expect(row!.protocol).toBe('openai-compatible');
  });
});

describe('供应商 CRUD 边界', () => {
  it('非法 baseUrl → 400；超长 name（>32）→ 400', async () => {
    const { request } = buildTestApp();
    const { token } = await newAdmin();
    expect(
      (await request('/v1/providers', { token, body: { name: uid('p'), baseUrl: 'not-a-url' } })).status,
    ).toBe(400);
    expect(
      (
        await request('/v1/providers', {
          token,
          body: { name: 'x'.repeat(33), baseUrl: 'https://api.example.com/v1' },
        })
      ).status,
    ).toBe(400);
  });

  it('重名 → 409（PG 唯一索引翻译）', async () => {
    const { request } = buildTestApp();
    const { token } = await newAdmin();
    const name = uid('dup');
    const first = await request('/v1/providers', { token, body: { name, baseUrl: 'https://a.example.com/v1' } });
    expect(first.status).toBe(201);
    const second = await request('/v1/providers', { token, body: { name, baseUrl: 'https://b.example.com/v1' } });
    expect(second.status).toBe(409);
    expect(((await second.json()) as { error: { code: string } }).error.code).toBe('conflict');
  });

  it('更新不存在 → 404；退役不存在 → 404；退役 = status 1 软删', async () => {
    const { request } = buildTestApp();
    const { token } = await newAdmin();
    expect(
      (await request('/v1/providers/999999999', { method: 'PATCH', token, body: { name: uid('x') } })).status,
    ).toBe(404);
    expect((await request('/v1/providers/999999999', { method: 'DELETE', token })).status).toBe(404);

    const created = (await (
      await request('/v1/providers', { token, body: { name: uid('ret'), baseUrl: 'https://c.example.com/v1' } })
    ).json()) as { id: number };
    const res = await request(`/v1/providers/${created.id}`, { method: 'DELETE', token });
    expect(res.status).toBe(200);
    const [row] = await db.select().from(providersTable).where(eq(providersTable.id, created.id));
    expect(row!.status).toBe(1);
  });

  it('排序白名单：未知 sort_by → 400 invalid_sort_field', async () => {
    const { request } = buildTestApp();
    const { token } = await newAdmin();
    const res = await request('/v1/providers?sort_by=password', { token });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('invalid_sort_field');
  });
});

describe('厂商档案 vendor（词表单一真相 = ai 包 VENDOR_PROFILES）', () => {
  it('合法档案 openai → 201 入库且列表回显；未知档案 → 400 且不触库', async () => {
    const { request } = buildTestApp();
    const { token } = await newAdmin();
    const bad = await request('/v1/providers', {
      token,
      body: { name: uid('p'), vendor: 'nonexistent-vendor', baseUrl: 'https://api.example.com/v1' },
    });
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as { error: { code: string } }).error.code).toBe('invalid_vendor');

    const name = uid('p');
    const ok = await request('/v1/providers', {
      token,
      body: { name, vendor: 'openai', baseUrl: 'https://api.openai.com/v1' },
    });
    expect(ok.status).toBe(201);
    expect(((await ok.json()) as { vendor: string }).vendor).toBe('openai');
    const [row] = await db.select().from(providersTable).where(eq(providersTable.name, name));
    expect(row?.vendor).toBe('openai');
  });

  it('PATCH vendor=null 清除档案（回退纯透传）', async () => {
    const { request } = buildTestApp();
    const { token } = await newAdmin();
    const name = uid('p');
    const created = await request('/v1/providers', {
      token,
      body: { name, vendor: 'openai', baseUrl: 'https://api.openai.com/v1' },
    });
    const id = ((await created.json()) as { id: number }).id;
    const res = await request(`/v1/providers/${id}`, {
      method: 'PATCH',
      token,
      body: { vendor: null },
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { vendor: string | null }).vendor).toBeNull();
  });
});

