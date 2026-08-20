import Link from 'next/link';
import { Store } from 'lucide-react';
import { cn } from '@ai-gateway/ui/lib/utils';
import { ApiError, adminFetch } from '@ai-gateway/api-client';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@ai-gateway/ui/components/ui/card';
import { CatalogContent, type CatalogItem, type FxState } from './_components/catalog-content';

export const dynamic = 'force-dynamic';

/**
 * 模型市场：多源货架（渠道型 = 可接入上游；字典型 = 行业参考，导入落草稿）。
 * 三态 diff（新增/上游涨价/上游降价）+ USD 预填换算（自动汇率 × 点差）+ 汇率追溯条。
 */
export default async function ModelMarketPage({
  searchParams,
}: {
  searchParams: Promise<{ source?: string }>;
}) {
  const params = await searchParams;
  let sources: Array<{
    id: string;
    name: string;
    kind: 'channel' | 'reference';
    priceCurrency: 'USD' | 'CNY';
    needsKey: boolean;
  }> = [];
  try {
    const data = await adminFetch<{ sources: typeof sources }>(
      '/api/admin/model-catalog/sources',
    );
    sources = data.sources;
  } catch {
    sources = [];
  }
  const active = sources.find((src) => src.id === params.source) ?? sources[0] ?? null;

  let items: CatalogItem[] = [];
  let gone: Array<{ mappingId: number; externalName: string; realModel: string }> = [];
  let fetchedAt = '';
  let channelReady = false;
  let fx: FxState | null = null;
  let error: string | null = null;
  if (active) {
    try {
      const data = await adminFetch<{
        items: CatalogItem[];
        gone: typeof gone;
        fetchedAt: string;
        channelReady: boolean;
        fx: FxState;
      }>(`/api/admin/model-catalog/${active.id}`);
      items = data.items;
      gone = data.gone ?? [];
      fetchedAt = data.fetchedAt;
      channelReady = data.channelReady;
      fx = data.fx;
    } catch (caught) {
      error = caught instanceof ApiError ? caught.message : '目录拉取失败';
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="flex items-center gap-2 text-2xl font-semibold">
          <Store className="size-5" />
          模型市场
        </h1>
        <p className="text-sm text-muted-foreground">
          多目录源同步入库（渠道型直接上架；字典型落草稿审批）；美元价自动按
          汇率×点差预填为你的卖价，提交即确认。每次定价留完整溯源（目录价 × 汇率 → 预填 → 提交）。
          <Link href="/dashboard/models" className="ml-2 underline">
            模型映射 →
          </Link>
        </p>
      </div>
      <Card>
        <CardHeader className="pb-2">
          <CardTitle>目录货架</CardTitle>
          <CardDescription>
            {sources.length > 1 ? (
              <span className="mr-4 inline-flex gap-1">
                {sources.map((src) => (
                  <Link
                    key={src.id}
                    href={`/dashboard/model-market?source=${src.id}`}
                    className={cn(
                      'rounded-md px-2 py-0.5 text-xs',
                      src.id === active?.id
                        ? 'bg-primary text-primary-foreground'
                        : 'bg-muted text-muted-foreground hover:bg-muted/70',
                    )}
                  >
                    {src.name}
                    {src.kind === 'reference' ? '（草稿）' : ''}
                  </Link>
                ))}
              </span>
            ) : null}
            {active?.kind === 'channel'
              ? channelReady
                ? `${active.name} 渠道已就绪，直接勾选导入。`
                : `首次从 ${active.name} 导入需填写平台 API Key（创建渠道，AES 加密存储）。`
              : active?.kind === 'reference'
                ? '字典型源：导入为草稿态（下架），价格复核后到「模型映射」手动上架。'
                : ''}
          </CardDescription>
        </CardHeader>
        <CardContent>
          {error ? (
            <p className="py-8 text-center text-sm text-destructive">{error}（稍后刷新重试）</p>
          ) : active ? (
            <CatalogContent
              sourceId={active.id}
              sourceName={active.name}
              sourceKind={active.kind}
              currency={active.priceCurrency}
              items={items}
              gone={gone}
              fetchedAt={fetchedAt}
              channelReady={channelReady}
              needsKey={active.needsKey}
              fx={fx}
            />
          ) : (
            <p className="py-8 text-center text-sm text-muted-foreground">
              暂无可用目录源（目录源在服务端注册）。
            </p>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
