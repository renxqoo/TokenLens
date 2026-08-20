'use client';

import { useState, useTransition } from 'react';

import {
  CpuIcon,
  FlaskConicalIcon,
  Loader2Icon,
  NetworkIcon,
  PencilIcon,
  PlusCircleIcon,
  Trash2Icon,
} from 'lucide-react';
import { Controller, useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';

import type { ModelTestResult } from '../actions';
import { Button } from '@ai-gateway/ui/components/ui/button';
import { Checkbox } from '@ai-gateway/ui/components/ui/checkbox';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@ai-gateway/ui/components/ui/dialog';
import { Field, FieldError, FieldGroup, FieldLabel } from '@ai-gateway/ui/components/ui/field';
import { Input } from '@ai-gateway/ui/components/ui/input';
import { NumberField } from '@ai-gateway/ui/components/ui/number-field';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@ai-gateway/ui/components/ui/table';
import { Textarea } from '@ai-gateway/ui/components/ui/textarea';
import { numericText } from '@ai-gateway/ui/lib/forms';
import { fmtPrice } from '@ai-gateway/api-client/formatters';

/** 上下文窗口 token 数展示：65536 → 64K，1000000 → 1M，未知 → — */
function fmtContext(tokens: number | null): string {
  if (tokens == null || tokens <= 0) return '—';
  if (tokens >= 1_000_000) return `${+(tokens / 1_000_000).toFixed(1)}M`;
  if (tokens >= 1_000) return `${Math.round(tokens / 1_000)}K`;
  return String(tokens);
}

import type { ChannelOption, AdminModelRow } from '@ai-gateway/api-client/types';
import { useActionResult } from "@ai-gateway/ui/components/action-toast";
import { ConfirmAction } from "@ai-gateway/ui/components/confirm-action";
import { StatusPill } from "@ai-gateway/ui/components/status-pill";

const createSchema = z.object({
  externalName: z.string().min(1),
  realModel: z.string().min(1),
  inputPrice: numericText({ message: '请输入有效价格' }).refine((v) => v >= 0, '价格不能为负'),
  outputPrice: numericText({ message: '请输入有效价格' }).refine((v) => v >= 0, '价格不能为负'),
  cacheInputPrice: numericText({ message: '请输入有效价格' }).refine((v) => v >= 0, '价格不能为负'),
  cacheWritePrice: numericText({ message: '请输入有效价格' }).refine((v) => v >= 0, '价格不能为负'),
  isFree: z.boolean().optional(),
  contextLength: numericText({ message: '请输入有效 token 数' }).refine(
    (v) => v === 0 || Number.isInteger(v),
    '需为整数',
  ),
});

export function ModelsTable({
  models,
  channels,
}: {
  readonly models: ReadonlyArray<AdminModelRow>;
  readonly channels: ReadonlyArray<ChannelOption>;
}) {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>外部名称</TableHead>
          <TableHead>真实模型</TableHead>
          <TableHead className="text-right">输入 / 百万 token</TableHead>
          <TableHead className="text-right">输出 / 百万 token</TableHead>
          <TableHead className="text-right">缓存 / 百万 token</TableHead>
          <TableHead>兜底模型</TableHead>
          <TableHead className="w-44">状态</TableHead>
          <TableHead className="text-right">上下文</TableHead>
          <TableHead className="w-32 text-right">操作</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {models.length === 0 ? (
          <TableRow>
            <TableCell colSpan={8} className="h-24 text-center text-muted-foreground">
              暂无模型
            </TableCell>
          </TableRow>
        ) : (
          models.map((m) => <ModelRowItem key={m.id} model={m} channels={channels} />)
        )}
      </TableBody>
    </Table>
  );
}

function ModelRowItem({
  model,
  channels,
}: {
  model: AdminModelRow;
  channels: ReadonlyArray<ChannelOption>;
}) {
  return (
    <TableRow>
      <TableCell>
        <code className="rounded bg-muted px-1.5 py-0.5 text-xs">{model.externalName}</code>
        {model.isFree && <StatusPill className="ml-2" tone="info" label="免费" />}
      </TableCell>
      <TableCell className="font-medium">{model.realModel}</TableCell>
      <TableCell className="text-right tabular-nums">¥{fmtPrice(model.inputPrice)}</TableCell>
      <TableCell className="text-right tabular-nums">¥{fmtPrice(model.outputPrice)}</TableCell>
      <TableCell className="text-right tabular-nums">¥{fmtPrice(model.cacheInputPrice)}</TableCell>
      <TableCell className="max-w-[160px] truncate text-xs text-muted-foreground">
        {model.fallbackModels ?? '—'}
      </TableCell>
      <TableCell>
        {model.status === 0 ? (
          <StatusPill tone="success" label="启用" />
        ) : (
          <StatusPill tone="neutral" label="禁用" />
        )}
      </TableCell>
      <TableCell className="text-right tabular-nums">{fmtContext(model.contextLength)}</TableCell>
      <TableCell>
        <div className="flex items-center justify-end gap-1">
          <BindChannelsDialog model={model} channels={channels} />
          <EditModelDialog model={model} />
          <TestModelDialog model={model} />
          <ConfirmAction
            confirm={`确定删除模型映射 ${model.externalName}？`}
            action={async () => (await import('../actions')).deleteModelAction(model.id)}
            success='已删除'
          >
            {({ pending, onClick }) => (
              <Button
                size="sm"
                variant="ghost"
                disabled={pending}
                onClick={onClick}
                className="text-destructive hover:text-destructive"
              >
                {pending ? <Loader2Icon className="animate-spin" /> : <Trash2Icon />}
              </Button>
            )}
          </ConfirmAction>
        </div>
      </TableCell>
    </TableRow>
  );
}

export function CreateModelDialog() {
  const notify = useActionResult();
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();
  type FormValues = z.input<typeof createSchema>;
  const form = useForm<FormValues>({
    resolver: zodResolver(createSchema) as never,
    defaultValues: {
      externalName: '',
      realModel: '',
      inputPrice: '',
      outputPrice: '',
      cacheInputPrice: '',
      cacheWritePrice: '',
      isFree: false,
      contextLength: '',
    },
  });

  function onSubmit(values: FormValues) {
    startTransition(async () => {
      const { createModelAction } = await import('../actions');
      const res = await createModelAction({
        externalName: values.externalName,
        realModel: values.realModel,
        inputPrice: Number(values.inputPrice),
        outputPrice: Number(values.outputPrice),
        cacheInputPrice: Number(values.cacheInputPrice),
        ...(values.cacheWritePrice !== '' ? { cacheWritePrice: Number(values.cacheWritePrice) } : {}),
        isFree: values.isFree ?? false,
        contextLength: values.contextLength === '' ? null : Number(values.contextLength),
      });
      if (!notify(res, '创建失败', '已创建')) return;
      form.reset();
      setOpen(false);
    });
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button>
          <PlusCircleIcon />
          新建模型映射
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <CpuIcon /> 新建模型映射
          </DialogTitle>
          <DialogDescription>把外部模型名映射到上游真实模型</DialogDescription>
        </DialogHeader>
        <ModelForm form={form} onSubmit={onSubmit} formId="model-form" />
        <DialogFooter>
          <DialogClose asChild>
            <Button variant="outline">取消</Button>
          </DialogClose>
          <Button type="submit" form="model-form" disabled={pending}>
            {pending && <Loader2Icon className="animate-spin" />}创建
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

const editSchema = z.object({
  externalName: z.string().min(1),
  realModel: z.string().min(1),
  inputPrice: numericText({ message: '请输入有效价格' }).refine((v) => v >= 0, '价格不能为负'),
  outputPrice: numericText({ message: '请输入有效价格' }).refine((v) => v >= 0, '价格不能为负'),
  cacheInputPrice: numericText({ message: '请输入有效价格' }).refine((v) => v >= 0, '价格不能为负'),
  cacheWritePrice: numericText({ message: '请输入有效价格' }).refine((v) => v >= 0, '价格不能为负'),
  isFree: z.boolean().optional(),
  contextLength: numericText({ message: '请输入有效 token 数' }).refine(
    (v) => v === 0 || Number.isInteger(v),
    '需为整数',
  ),
  fallbackModels: z.string().optional(),
  paramRules: z.string().optional(),
  billingPolicy: z
    .string()
    .optional()
    .refine((value) => {
      if (!value?.trim()) return true;
      try {
        JSON.parse(value);
        return true;
      } catch {
        return false;
      }
    }, '请输入合法 JSON'),
  rpmLimit: z.string().optional(),
  tpmLimit: z.string().optional(),
  status: numericText({ message: '请输入整数' }).refine((v) => Number.isInteger(v), '请输入整数'),
});

function EditModelDialog({ model }: { model: AdminModelRow }) {
  const notify = useActionResult();
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();
  type FormValues = z.input<typeof editSchema>;
  const form = useForm<FormValues>({
    resolver: zodResolver(editSchema) as never,
    defaultValues: {
      externalName: model.externalName,
      realModel: model.realModel,
      inputPrice: model.inputPrice ?? '',
      outputPrice: model.outputPrice ?? '',
      cacheInputPrice: model.cacheInputPrice ?? '',
      cacheWritePrice: model.cacheWritePrice ?? '',
      isFree: model.isFree ?? false,
      contextLength: model.contextLength == null ? '' : String(model.contextLength),
      fallbackModels: model.fallbackModels ?? '',
      paramRules: model.paramRules ?? '',
      billingPolicy: model.billingPolicy ? JSON.stringify(model.billingPolicy, null, 2) : '',
      rpmLimit: model.rpmLimit === null ? '' : String(model.rpmLimit),
      tpmLimit: model.tpmLimit === null ? '' : String(model.tpmLimit),
      status: String(model.status),
    },
  });

  function onSubmit(values: FormValues) {
    startTransition(async () => {
      const { updateModelAction } = await import('../actions');
      const res = await updateModelAction(model.id, {
        externalName: values.externalName,
        realModel: values.realModel,
        inputPrice: Number(values.inputPrice),
        outputPrice: Number(values.outputPrice),
        cacheInputPrice: Number(values.cacheInputPrice),
        ...(values.cacheWritePrice !== '' ? { cacheWritePrice: Number(values.cacheWritePrice) } : {}),
        isFree: values.isFree ?? false,
        contextLength: values.contextLength === '' ? null : Number(values.contextLength),
        fallbackModels: values.fallbackModels?.trim() || undefined,
        paramRules: values.paramRules?.trim() || undefined,
        billingPolicy: values.billingPolicy?.trim()
          ? (JSON.parse(values.billingPolicy) as Record<string, unknown>)
          : null,
        rpmLimit: values.rpmLimit === '' ? null : Number(values.rpmLimit),
        tpmLimit: values.tpmLimit === '' ? null : Number(values.tpmLimit),
        status: Number(values.status),
      });
      if (!notify(res, '保存失败', '已保存')) return;
      setOpen(false);
    });
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm" variant="ghost" title="编辑">
          <PencilIcon />
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <PencilIcon /> 编辑模型 - {model.externalName}
          </DialogTitle>
        </DialogHeader>
        <ModelForm form={form} onSubmit={onSubmit} formId="model-edit-form" isEdit />
        <DialogFooter>
          <DialogClose asChild>
            <Button variant="outline">取消</Button>
          </DialogClose>
          <Button type="submit" form="model-edit-form" disabled={pending}>
            {pending && <Loader2Icon className="animate-spin" />}保存
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function ModelForm({
  form,
  onSubmit,
  formId,
  isEdit = false,
}: {
  form: any;
  onSubmit: (v: never) => void;
  formId: string;
  isEdit?: boolean;
}) {
  return (
    <form id={formId} onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
      <FieldGroup>
        <div className="grid grid-cols-2 gap-3">
          <Controller
            control={form.control}
            name="externalName"
            render={({
              field,
              fieldState,
            }: {
              field: { value: string };
              fieldState: { invalid?: boolean; error?: { message?: string } };
            }) => (
              <Field data-invalid={fieldState.invalid}>
                <FieldLabel htmlFor="m-ext">外部名称</FieldLabel>
                <Input id="m-ext" placeholder="例如 gpt-4o-mini" {...field} />
                {fieldState.invalid && <FieldError errors={[fieldState.error]} />}
              </Field>
            )}
          />
          <Controller
            control={form.control}
            name="realModel"
            render={({
              field,
              fieldState,
            }: {
              field: { value: string };
              fieldState: { invalid?: boolean; error?: { message?: string } };
            }) => (
              <Field data-invalid={fieldState.invalid}>
                <FieldLabel htmlFor="m-real">真实模型</FieldLabel>
                <Input id="m-real" placeholder="例如 gpt-4o-mini-2024-07-18" {...field} />
                {fieldState.invalid && <FieldError errors={[fieldState.error]} />}
              </Field>
            )}
          />
        </div>
        <div className="grid grid-cols-3 gap-3">
          <NumberField
            control={form.control}
            name="inputPrice"
            label="输入价"
            id="m-in"
            step="0.0001"
          />
          <NumberField
            control={form.control}
            name="outputPrice"
            label="输出价"
            id="m-out"
            step="0.0001"
          />
          <NumberField
            control={form.control}
            name="cacheInputPrice"
            label="缓存价"
            id="m-cache"
            step="0.0001"
          />
          <NumberField
            control={form.control}
            name="cacheWritePrice"
            label="缓存写价"
            id="m-cache-w"
            step="0.0001"
          />
          <NumberField
            control={form.control}
            name="contextLength"
            label="上下文（token）"
            id="m-ctx"
            step="1"
          />
        </div>
        <p className="text-xs text-muted-foreground">单位：元 / 百万 token</p>
        <Controller
          control={form.control}
          name="isFree"
          render={({ field }: { field: { value?: boolean; onChange: (v: boolean) => void } }) => (
            <label className="flex items-center gap-2 text-sm">
              <Checkbox
                checked={field.value ?? false}
                onCheckedChange={(v) => field.onChange(v === true)}
              />
              显式免费模型（0 元授权，不预留余额/额度）
            </label>
          )}
        />
        {isEdit && (
          <>
            <Controller
              control={form.control}
              name="fallbackModels"
              render={({ field }: { field: { value: string } }) => (
                <Field>
                  <FieldLabel htmlFor="m-fb">兜底模型（逗号分隔）</FieldLabel>
                  <Input id="m-fb" {...field} />
                </Field>
              )}
            />
            <Controller
              control={form.control}
              name="paramRules"
              render={({ field }: { field: { value: string } }) => (
                <Field>
                  <FieldLabel htmlFor="m-rules">参数规则（JSON）</FieldLabel>
                  <Textarea id="m-rules" rows={3} className="font-mono text-xs" {...field} />
                </Field>
              )}
            />
            <Controller
              control={form.control}
              name="billingPolicy"
              render={({ field }: { field: { value: string } }) => (
                <Field>
                  <FieldLabel htmlFor="m-billing-policy">多模态计费策略（JSON）</FieldLabel>
                  <Textarea
                    id="m-billing-policy"
                    rows={8}
                    className="font-mono text-xs"
                    placeholder={
                      '{"version":1,"billingMode":"unified_input_tokens","maxInputTokens":128000,"modalities":{"image":{"maxItems":20,"maxInlineBytes":20971520}}}'
                    }
                    {...field}
                  />
                </Field>
              )}
            />
            <div className="grid grid-cols-3 gap-3">
              <Controller
                control={form.control}
                name="rpmLimit"
                render={({ field }: { field: { value: string } }) => (
                  <Field>
                    <FieldLabel htmlFor="m-rpm">RPM（空=默认）</FieldLabel>
                    <Input id="m-rpm" type="number" {...field} />
                  </Field>
                )}
              />
              <Controller
                control={form.control}
                name="tpmLimit"
                render={({ field }: { field: { value: string } }) => (
                  <Field>
                    <FieldLabel htmlFor="m-tpm">TPM（空=默认）</FieldLabel>
                    <Input id="m-tpm" type="number" {...field} />
                  </Field>
                )}
              />
              <NumberField
                control={form.control}
                name="status"
                label="状态"
                id="m-status"
                step="1"
                min={0}
              />
            </div>
          </>
        )}
      </FieldGroup>
    </form>
  );
}

function BindChannelsDialog({
  model,
  channels,
}: {
  model: AdminModelRow;
  channels: ReadonlyArray<ChannelOption>;
}) {
  const notify = useActionResult();
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();
  const [selected, setSelected] = useState<number[]>(model.channelIds ?? []);

  function toggle(id: number) {
    setSelected((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  }

  function onSubmit() {
    startTransition(async () => {
      const { bindChannelsAction } = await import('../actions');
      const res = await bindChannelsAction(model.id, selected);
      if (!notify(res, '绑定失败', `已绑定 ${selected.length} 个渠道`)) return;
      setSelected([]);
      setOpen(false);
    });
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        // 每次打开回显当前已绑定渠道（取消后再打开也重置为最新绑定）
        if (o) setSelected(model.channelIds ?? []);
      }}
    >
      <DialogTrigger asChild>
        <Button size="sm" variant="ghost" title="绑定渠道">
          <NetworkIcon />
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <NetworkIcon /> 绑定渠道 - {model.externalName}
          </DialogTitle>
          <DialogDescription>勾选为该模型提供服务的渠道（会全量覆盖原绑定）</DialogDescription>
        </DialogHeader>
        <div className="max-h-80 space-y-2 overflow-y-auto">
          {channels.length === 0 ? (
            <p className="py-4 text-center text-sm text-muted-foreground">暂无可用渠道</p>
          ) : (
            channels.map((c) => (
              <label
                key={c.id}
                className="flex cursor-pointer items-center gap-3 rounded-md border p-2 hover:bg-muted/50"
              >
                <Checkbox checked={selected.includes(c.id)} onCheckedChange={() => toggle(c.id)} />
                <div className="flex-1">
                  <p className="text-sm font-medium">{c.name}</p>
                  <p className="text-xs text-muted-foreground">{c.providerName}</p>
                </div>
                <span className="text-xs text-muted-foreground">#{c.id}</span>
              </label>
            ))
          )}
        </div>
        <DialogFooter>
          <DialogClose asChild>
            <Button variant="outline">取消</Button>
          </DialogClose>
          <Button disabled={pending} onClick={onSubmit}>
            {pending && <Loader2Icon className="animate-spin" />}确认绑定（{selected.length}）
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** 模型级测试：逐绑定渠道真实最小生成（"1" + max_tokens 1，厘级成本） */
export function TestModelDialog({ model }: { model: AdminModelRow }) {
  const [open, setOpen] = useState(false);
  const [results, setResults] = useState<ModelTestResult[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) {
          setResults(null);
          setError(null);
        }
      }}
    >
      <DialogTrigger asChild>
        <Button
          size="sm"
          variant="ghost"
          title="逐渠道发真实最小生成，验证映射配置可用"
          onClick={() => {
            setResults(null);
            setError(null);
            startTransition(async () => {
              const { testModelAction } = await import('../actions');
              const res = await testModelAction(model.id);
              if (res.error) setError(res.error);
              else setResults(res.results ?? []);
            });
          }}
        >
          <FlaskConicalIcon />
        </Button>
      </DialogTrigger>
      <DialogContent className="w-[32rem] max-w-[90vw]">
        <DialogHeader>
          <DialogTitle>测试 {model.externalName}</DialogTitle>
          <DialogDescription>
            逐绑定渠道发送真实最小生成（提示词 "1" + max_tokens 1）。付费模型成本为厘级/次。
          </DialogDescription>
        </DialogHeader>
        {pending ? (
          <div className="flex items-center justify-center py-8 text-muted-foreground">
            <Loader2Icon className="mr-2 animate-spin" /> 正在逐渠道测试…
          </div>
        ) : error ? (
          <p className="py-6 text-center text-sm text-destructive">{error}</p>
        ) : results ? (
          results.length === 0 ? (
            <p className="py-6 text-center text-sm text-muted-foreground">
              该模型尚未绑定渠道，先绑定再测试。
            </p>
          ) : (
            <ul className="flex flex-col gap-2">
              {results.map((r) => (
                <li
                  key={r.channelId}
                  className="flex items-center justify-between rounded-md border px-3 py-2 text-sm"
                >
                  <span className="font-medium">{r.channel}</span>
                  {r.ok ? (
                    <span className="text-emerald-600">
                      ✓ {r.durationMs}ms · {r.tokens ?? 0} tokens
                    </span>
                  ) : (
                    <span className="max-w-56 truncate text-destructive" title={r.error?.message}>
                      ✗ {r.error?.code ?? 'error'}
                    </span>
                  )}
                </li>
              ))}
            </ul>
          )
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
