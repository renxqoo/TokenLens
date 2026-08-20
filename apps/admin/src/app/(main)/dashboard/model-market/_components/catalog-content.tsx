'use client';

import { useMemo, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import {
  ArrowDownIcon,
  ArrowUpIcon,
  HistoryIcon,
  Loader2Icon,
  RefreshCwIcon,
  StoreIcon,
  TriangleAlertIcon,
} from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@ai-gateway/ui/components/ui/button';
import { Checkbox } from '@ai-gateway/ui/components/ui/checkbox';
import { Input } from '@ai-gateway/ui/components/ui/input';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@ai-gateway/ui/components/ui/table';
import { Badge } from '@ai-gateway/ui/components/ui/badge';
import { fmtDateTime } from '@ai-gateway/api-client/formatters';
import { useActionResult } from '@ai-gateway/ui/components/action-toast';
import {
  clearFxOverrideAction,
  importCatalogAction,
  priceHistoryAction,
  refreshFxAction,
  setFxBufferAction,
  setFxOverrideAction,
  type PriceHistoryEntry,
} from '../actions';

/**
 * 模型目录货架（多源）：勾选 → 预填价（USD 源 = 目录价 × 生效汇率，可改）→ 提交即确认。
 * 三态 diff 徽章（新增 / 上游涨价 / 上游降价）+ 亏钱警告 + 汇率条（覆盖/点差/强刷）+
 * 价格溯源时间线（目录价 × 汇率 → 预填 → 提交）。
 */

export interface FxState {
  mode: 'auto' | 'override';
  baseRate: string | null;
  effectiveRate: string | null;
  bufferPct: string;
  source: string | null;
  fetchedAt: string | null;
}

export interface CatalogItem {
  realModel: string;
  displayName: string;
  contextLength: number | null;
  currency: 'USD' | 'CNY';
  catalogPrompt: string;
  catalogCompletion: string;
  suggestedName: string;
  imported: { externalName: string; inputPrice: string; outputPrice: string } | null;
  diff: 'new' | 'same' | 'price_up' | 'price_down';
  driftPct: number | null;
  isFree: boolean;
  priceWarning: boolean;
  prefillInputCny: string | null;
  prefillOutputCny: string | null;
}

interface Draft {
  selected: boolean;
  externalName: string;
  inputPrice: string;
  outputPrice: string;
  cacheInputPrice: string;
  cacheWritePrice: string;
  contextLength: string;
}

type PriceFilter = 'all' | 'free' | 'paid';
type StateFilter = 'all' | 'new' | 'changed' | 'imported';

const DIFF_BADGES: Record<CatalogItem['diff'], { label: string; className: string } | null> = {
  new: { label: '未导入', className: 'bg-muted text-muted-foreground' },
  same: null,
  price_up: { label: '上游涨价', className: 'bg-amber-500/15 text-amber-600' },
  price_down: { label: '上游降价', className: 'bg-emerald-500/15 text-emerald-600' },
};

export function CatalogContent({
  sourceId,
  sourceName,
  sourceKind,
  currency,
  items,
  gone,
  fetchedAt,
  channelReady,
  needsKey,
  fx,
}: {
  sourceId: string;
  sourceName: string;
  sourceKind: 'channel' | 'reference';
  currency: 'USD' | 'CNY';
  items: CatalogItem[];
  gone: Array<{ mappingId: number; externalName: string; realModel: string }>;
  fetchedAt: string;
  channelReady: boolean;
  needsKey: boolean;
  fx: FxState | null;
}) {
  const router = useRouter();
  const [apiKey, setApiKey] = useState('');
  const [query, setQuery] = useState('');
  const [priceFilter, setPriceFilter] = useState<PriceFilter>('all');
  const [stateFilter, setStateFilter] = useState<StateFilter>('all');
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [pending, startTransition] = useTransition();
  const notify = useActionResult();

  // 汇率条编辑态
  const [fxEditing, setFxEditing] = useState(false);
  const [overrideRate, setOverrideRate] = useState('');
  const [bufferPct, setBufferPct] = useState('');
  const [historyOf, setHistoryOf] = useState<string | null>(null);
  const [historyEntries, setHistoryEntries] = useState<PriceHistoryEntry[] | null>(null);
  const [historyPending, startHistory] = useTransition();

  const changedCount = items.filter((i) => i.diff === 'price_up' || i.diff === 'price_down').length;
  const newCount = items.filter((i) => i.diff === 'new').length;

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return items.filter((i) => {
      if (q && !i.realModel.toLowerCase().includes(q) && !i.displayName.toLowerCase().includes(q) && !i.suggestedName.toLowerCase().includes(q)) return false;
      if (priceFilter === 'free' && !i.isFree) return false;
      if (priceFilter === 'paid' && i.isFree) return false;
      if (stateFilter === 'new' && i.diff !== 'new') return false;
      if (stateFilter === 'changed' && i.diff !== 'price_up' && i.diff !== 'price_down') return false;
      if (stateFilter === 'imported' && i.imported == null) return false;
      return true;
    });
  }, [items, query, priceFilter, stateFilter]);

  function draftOf(item: CatalogItem): Draft {
    return (
      drafts[item.realModel] ?? {
        selected: false,
        externalName: item.suggestedName,
        // 预填：USD 源 = 服务端换算值（× 生效汇率）；汇率不可用时回落 0（免费安全）
        inputPrice: item.prefillInputCny ?? '0',
        outputPrice: item.prefillOutputCny ?? '0',
        cacheInputPrice: '0',
        cacheWritePrice: '0',
        contextLength: item.contextLength != null ? String(item.contextLength) : '',
      }
    );
  }

  const selectedItems = filtered.filter((i) => draftOf(i).selected);

  function toggle(item: CatalogItem, selected: boolean): void {
    const d = draftOf(item);
    setDrafts((prev) => ({ ...prev, [item.realModel]: { ...d, selected } }));
  }

  function patch(item: CatalogItem, patchValue: Partial<Draft>): void {
    const d = draftOf(item);
    setDrafts((prev) => ({ ...prev, [item.realModel]: { ...d, ...patchValue } }));
  }

  function selectAll(selected: boolean): void {
    const next: Record<string, Draft> = { ...drafts };
    for (const i of filtered) next[i.realModel] = { ...draftOf(i), selected };
    setDrafts(next);
  }

  function applyDiff(kind: 'price_up' | 'price_down'): void {
    // 一键跟进：把该方向漂移的行全选（预填已是换算新价，提交仍走确认）
    const next: Record<string, Draft> = { ...drafts };
    for (const i of items.filter((x) => x.diff === kind && x.prefillInputCny != null)) {
      next[i.realModel] = {
        ...draftOf(i),
        selected: true,
        inputPrice: i.prefillInputCny ?? '0',
        outputPrice: i.prefillOutputCny ?? '0',
      };
    }
    setDrafts(next);
    toast.info(kind === 'price_up' ? '已勾选全部上游涨价行（防亏钱方向）' : '已勾选全部上游降价行（让利决策）');
  }

  function doImport(): void {
    if (selectedItems.length === 0) return;
    if (needsKey && !channelReady && apiKey.trim().length === 0) {
      toast.error(`首次从 ${sourceName} 导入需要填写平台 API Key`);
      return;
    }
    startTransition(async () => {
      const res = await importCatalogAction({
        sourceId,
        ...(needsKey && !channelReady ? { apiKey: apiKey.trim() } : {}),
        models: selectedItems.map((i) => {
          const d = draftOf(i);
          return {
            externalName: d.externalName,
            realModel: i.realModel,
            inputPrice: Number(d.inputPrice) || 0,
            outputPrice: Number(d.outputPrice) || 0,
            cacheInputPrice: Number(d.cacheInputPrice) || 0,
            cacheWritePrice: Number(d.cacheWritePrice) || 0,
            ...(d.contextLength.trim() !== '' && Number.isInteger(Number(d.contextLength))
              ? { contextLength: Number(d.contextLength) }
              : {}),
          };
        }),
      });
      if (notify(res, undefined, sourceKind === 'reference'
        ? `已导入 ${selectedItems.length} 个模型为草稿（到「模型映射」复核上架）`
        : `已导入 ${selectedItems.length} 个模型（价格按提交值生效）`)) router.refresh();
    });
  }

  function saveFx(): void {
    startTransition(async () => {
      if (overrideRate.trim()) {
        const res = await setFxOverrideAction(overrideRate.trim());
        if (res.error) { toast.error(res.error); return; }
      } else {
        const res = await clearFxOverrideAction();
        if (res.error) { toast.error(res.error); return; }
      }
      if (bufferPct.trim()) {
        const res = await setFxBufferAction(bufferPct.trim());
        if (res.error) { toast.error(res.error); return; }
      }
      setFxEditing(false);
      setOverrideRate('');
      setBufferPct('');
      toast.success('汇率配置已更新（动作已留审计）');
      router.refresh();
    });
  }

  function openHistory(externalName: string): void {
    setHistoryOf(externalName);
    setHistoryEntries(null);
    startHistory(async () => {
      const res = await priceHistoryAction(externalName);
      if (res.error) { toast.error(res.error); return; }
      setHistoryEntries(res.entries ?? []);
    });
  }

  return (
    <div className="flex flex-col gap-3">
      {/* 汇率条（USD 源显示；追溯口径：请求账单快照基准汇率，点差只进预填） */}
      {currency === 'USD' && fx ? (
        <div className="flex flex-wrap items-center gap-2 rounded-md border bg-muted/30 px-3 py-2 text-xs">
          <span className="font-medium">
            汇率 {fx.baseRate ?? '不可用'}
            {fx.mode === 'override' ? '（手动覆盖）' : `（${fx.source === 'ecb' ? 'ECB 自动' : fx.source ?? '—'}）`}
          </span>
          {fx.bufferPct !== '0' ? <Badge variant="outline">点差 +{fx.bufferPct}%</Badge> : null}
          {fx.effectiveRate != null ? <span className="text-muted-foreground">预填生效 {fx.effectiveRate}</span> : null}
          {fx.fetchedAt ? <span className="text-muted-foreground">· {fmtDateTime(fx.fetchedAt)}</span> : null}
          <div className="ml-auto flex items-center gap-2">
            {fxEditing ? (
              <>
                <Input
                  placeholder={`覆盖汇率（当前 ${fx.baseRate ?? '—'}；留空=清除回落自动）`}
                  value={overrideRate}
                  onChange={(e) => setOverrideRate(e.target.value)}
                  className="h-7 w-56 text-xs"
                />
                <Input
                  placeholder={`点差 %（当前 ${fx.bufferPct}）`}
                  value={bufferPct}
                  onChange={(e) => setBufferPct(e.target.value)}
                  className="h-7 w-36 text-xs"
                />
                <Button size="sm" className="h-7" disabled={pending} onClick={saveFx}>保存</Button>
                <Button size="sm" variant="ghost" className="h-7" onClick={() => setFxEditing(false)}>取消</Button>
              </>
            ) : (
              <>
                <Button size="sm" variant="outline" className="h-7" onClick={() => setFxEditing(true)}>改</Button>
                <Button
                  size="sm"
                  variant="outline"
                  className="h-7"
                  disabled={pending}
                  onClick={() => startTransition(async () => {
                    const res = await refreshFxAction(true);
                    if (res.error) toast.error(res.error);
                    else { toast.success('已强制刷新'); router.refresh(); }
                  })}
                >
                  <RefreshCwIcon className="mr-1 size-3" /> 强刷
                </Button>
              </>
            )}
          </div>
        </div>
      ) : null}

      <div className="flex flex-wrap items-center gap-2">
        <Input
          placeholder="搜索模型…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          className="w-52"
        />
        <div className="flex gap-1 text-xs">
          {([['all', '全部'], ['free', '免费'], ['paid', '付费']] as const).map(([k, label]) => (
            <button
              key={k}
              type="button"
              onClick={() => setPriceFilter(k)}
              className={`rounded-md px-2 py-1 ${priceFilter === k ? 'bg-primary text-primary-foreground' : 'bg-muted text-muted-foreground'}`}
            >
              {label}
            </button>
          ))}
        </div>
        <div className="flex gap-1 text-xs">
          {([['all', '全部'], ['new', `未导入 ${newCount}`], ['changed', `有变化 ${changedCount}`], ['imported', '已导入']] as const).map(([k, label]) => (
            <button
              key={k}
              type="button"
              onClick={() => setStateFilter(k)}
              className={`rounded-md px-2 py-1 ${stateFilter === k ? 'bg-primary text-primary-foreground' : 'bg-muted text-muted-foreground'}`}
            >
              {label}
            </button>
          ))}
        </div>
        {changedCount > 0 && sourceKind === 'channel' ? (
          <div className="flex gap-1">
            <Button size="sm" variant="outline" className="h-7 text-xs" onClick={() => applyDiff('price_up')}>
              <ArrowUpIcon className="mr-1 size-3" /> 跟进涨价（防亏）
            </Button>
            <Button size="sm" variant="outline" className="h-7 text-xs" onClick={() => applyDiff('price_down')}>
              <ArrowDownIcon className="mr-1 size-3" /> 跟进降价（让利）
            </Button>
          </div>
        ) : null}
        <span className="text-xs text-muted-foreground">
          {sourceName} 目录抓取于 {fmtDateTime(fetchedAt)} · 共 {items.length} 个模型
        </span>
        <div className="ml-auto flex items-center gap-2">
          {needsKey && !channelReady ? (
            <Input
              type="password"
              placeholder={`${sourceName} API Key（首次导入必填）`}
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              className="w-72"
            />
          ) : null}
          <Button disabled={pending || selectedItems.length === 0} onClick={doImport}>
            {pending ? <Loader2Icon className="mr-1 animate-spin" /> : <StoreIcon className="mr-1" />}
            {sourceKind === 'reference' ? '导入选中为草稿' : '导入选中'}（{selectedItems.length}）
          </Button>
        </div>
      </div>

      <div className="rounded-lg border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-10">
                <Checkbox
                  checked={filtered.length > 0 && selectedItems.length === filtered.length}
                  onCheckedChange={(v) => selectAll(v === true)}
                />
              </TableHead>
              <TableHead>上游模型</TableHead>
              <TableHead className="w-40">对外名（可改）</TableHead>
              <TableHead className="w-32 text-right">目录价（{currency}/1M）</TableHead>
              <TableHead className="w-24 text-right">输入价 ¥</TableHead>
              <TableHead className="w-24 text-right">输出价 ¥</TableHead>
              <TableHead className="w-24 text-right">缓存价 ¥</TableHead>
              <TableHead className="w-24 text-right">写价 ¥</TableHead>
              <TableHead className="w-24 text-right">上下文</TableHead>
              <TableHead className="w-32">状态</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {filtered.map((item) => {
              const d = draftOf(item);
              const badge = DIFF_BADGES[item.diff];
              return (
                <TableRow key={item.realModel} className={item.priceWarning ? 'bg-destructive/5' : undefined}>
                  <TableCell>
                    <Checkbox
                      checked={d.selected}
                      onCheckedChange={(v) => toggle(item, v === true)}
                    />
                  </TableCell>
                  <TableCell>
                    <div className="flex flex-col">
                      <code className="text-xs">{item.realModel}</code>
                      <span className="text-xs text-muted-foreground">{item.displayName}</span>
                    </div>
                  </TableCell>
                  <TableCell>
                    <Input
                      value={d.externalName}
                      onChange={(e) => patch(item, { externalName: e.target.value })}
                      className="h-8 text-xs"
                    />
                  </TableCell>
                  <TableCell className="text-right text-xs tabular-nums text-muted-foreground">
                    {item.currency === 'USD' ? '$' : '¥'}
                    {Number(item.catalogPrompt)} / {Number(item.catalogCompletion)}
                  </TableCell>
                  <TableCell>
                    <Input
                      value={d.inputPrice}
                      onChange={(e) => patch(item, { inputPrice: e.target.value })}
                      className="h-8 text-right text-xs tabular-nums"
                      title={item.prefillInputCny != null ? `预填 = 目录价 × 生效汇率 ${fx?.effectiveRate ?? ''}` : '汇率不可用，手填'}
                    />
                  </TableCell>
                  <TableCell>
                    <Input
                      value={d.outputPrice}
                      onChange={(e) => patch(item, { outputPrice: e.target.value })}
                      className="h-8 text-right text-xs tabular-nums"
                    />
                  </TableCell>
                  <TableCell>
                    <Input
                      value={d.cacheInputPrice}
                      onChange={(e) => patch(item, { cacheInputPrice: e.target.value })}
                      className="h-8 text-right text-xs tabular-nums"
                    />
                  </TableCell>
                  <TableCell>
                    <Input
                      value={d.cacheWritePrice}
                      onChange={(e) => patch(item, { cacheWritePrice: e.target.value })}
                      className="h-8 text-right text-xs tabular-nums"
                      title="缓存写价（Anthropic 1.25×/2× 输入价；0/缺省按输入价收）"
                    />
                  </TableCell>
                  <TableCell>
                    <Input
                      value={d.contextLength}
                      placeholder="—"
                      onChange={(e) => patch(item, { contextLength: e.target.value })}
                      className="h-8 text-right text-xs tabular-nums"
                      title="上下文窗口（token），默认取目录值"
                    />
                  </TableCell>
                  <TableCell>
                    <div className="flex flex-wrap gap-1">
                      {badge ? (
                        <Badge variant="outline" className={badge.className}>
                          {badge.label}
                          {item.driftPct != null && item.driftPct !== 0 ? ` ${item.driftPct > 0 ? '+' : ''}${item.driftPct}%` : ''}
                        </Badge>
                      ) : null}
                      {item.imported ? (
                        <Badge variant="outline">已导入 {item.imported.externalName}</Badge>
                      ) : null}
                      {item.priceWarning ? (
                        <Badge variant="destructive" className="gap-1">
                          <TriangleAlertIcon className="size-3" />
                          上游已收费
                        </Badge>
                      ) : null}
                      {item.imported ? (
                        <button
                          type="button"
                          className="text-muted-foreground hover:text-foreground"
                          title="价格溯源：历次导入/改价的汇率与预填依据"
                          onClick={() => openHistory(item.imported!.externalName)}
                        >
                          <HistoryIcon className="size-3.5" />
                        </button>
                      ) : null}
                    </div>
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </div>

      {/* 上游消失（channel 源）：绑定到本源渠道但目录已无——复核下架 */}
      {sourceKind === 'channel' && gone.length > 0 ? (
        <div className="rounded-md border border-amber-500/40 bg-amber-500/5 px-3 py-2 text-xs">
          <span className="font-medium text-amber-600">上游消失 {gone.length} 条：</span>
          <span className="ml-2 text-muted-foreground">
            {gone.slice(0, 8).map((g) => g.externalName).join('、')}
            {gone.length > 8 ? ` 等 ${gone.length} 条` : ''}——目录已无这些模型，复核后到「模型映射」处理。
          </span>
        </div>
      ) : null}

      {/* 价格溯源时间线 */}
      {historyOf != null ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-6" onClick={() => setHistoryOf(null)}>
          <div className="max-h-[70vh] w-full max-w-2xl overflow-auto rounded-lg border bg-background p-4 shadow-lg" onClick={(e) => e.stopPropagation()}>
            <div className="mb-3 flex items-center justify-between">
              <h3 className="text-sm font-semibold">价格溯源 · {historyOf}</h3>
              <Button size="sm" variant="ghost" onClick={() => setHistoryOf(null)}>关闭</Button>
            </div>
            {historyPending || historyEntries == null ? (
              <p className="py-6 text-center text-xs text-muted-foreground">查询中…</p>
            ) : historyEntries.length === 0 ? (
              <p className="py-6 text-center text-xs text-muted-foreground">无目录导入记录（人工在「模型映射」直接改价的不在此列）。</p>
            ) : (
              <ol className="flex flex-col gap-3">
                {historyEntries.map((h, i) => (
                  <li key={i} className="rounded-md border p-3 text-xs">
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge variant="outline">{h.action === 'model_catalog.import_draft' ? '字典草稿导入' : '目录导入/更新'}</Badge>
                      <span className="text-muted-foreground">{fmtDateTime(h.createdAt)}</span>
                      {h.adminId != null ? <span className="text-muted-foreground">管理员 #{h.adminId}</span> : null}
                    </div>
                    <div className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 text-muted-foreground md:grid-cols-4">
                      <span>目录价：${h.catalogPrompt ?? '—'} / ${h.catalogCompletion ?? '—'}</span>
                      <span>汇率：{h.fx ? `${h.fx.baseRate}（${h.fx.source ?? '—'}${h.fx.effectiveRate != null && h.fx.effectiveRate !== h.fx.baseRate ? `，生效 ${h.fx.effectiveRate}` : ''}）` : '—'}</span>
                      <span>预填：¥{h.prefillInputCny ?? '—'}</span>
                      <span className="font-medium text-foreground">提交：¥{h.submittedInputCny} / ¥{h.submittedOutputCny}</span>
                    </div>
                  </li>
                ))}
              </ol>
            )}
          </div>
        </div>
      ) : null}

      <p className="text-xs text-muted-foreground">
        价格单位为 元/百万 token；USD 源预填 = 目录价 × 生效汇率（自动 ×(1+点差) 或手动覆盖），提交即确认为你的卖价；
        {sourceKind === 'reference' ? ' 字典型导入落草稿态，复核后上架。' : ' 渠道限流预填 20 RPM。'}
        导入后到「模型映射」点烧瓶图标逐渠道测试。每笔请求账单另落「当时基准汇率」（usage_logs.fx_rate）供对账。
      </p>
    </div>
  );
}
