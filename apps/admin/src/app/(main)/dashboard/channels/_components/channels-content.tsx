'use client';

import { useState } from 'react';

import {
  Loader2Icon,
  NetworkIcon,
  PencilIcon,
  PlusCircleIcon,
  Trash2Icon,
  UploadIcon,
  WifiIcon,
} from 'lucide-react';
import { useTranslations } from 'next-intl';
import { Controller, useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { toast } from 'sonner';
import { z } from 'zod';

import { formatMoney } from '@ai-gateway/api-client/formatters';

import { useActionResult } from '@ai-gateway/ui/components/action-toast';
import { ConfirmAction } from '@ai-gateway/ui/components/confirm-action';
import { FormDialog } from '@ai-gateway/ui/components/form-dialog';
import { defineStatusMeta, StatusPill } from '@ai-gateway/ui/components/status-pill';
import { Button } from '@ai-gateway/ui/components/ui/button';
import { Field, FieldError, FieldGroup, FieldLabel } from '@ai-gateway/ui/components/ui/field';
import { Input } from '@ai-gateway/ui/components/ui/input';
import { NumberField } from '@ai-gateway/ui/components/ui/number-field';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@ai-gateway/ui/components/ui/select';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@ai-gateway/ui/components/ui/table';
import { Textarea } from '@ai-gateway/ui/components/ui/textarea';
import { moneyText, numericText } from '@ai-gateway/ui/lib/forms';

import type { AdminChannelRow, ProviderOption } from '@ai-gateway/api-client/types';

// 状态 tone 映射留模块级；label 是 channels 命名空间的 i18n key，渲染处用 t 解析
const STATUS_META = defineStatusMeta(
  {
    0: { label: 'statusEnabled', tone: 'success' },
    1: { label: 'statusDegraded', tone: 'warning' },
    2: { label: 'statusDisabled', tone: 'neutral' },
    3: { label: 'statusCooldown', tone: 'warning' },
    // 4 = 凭据无效（worker 连续 401/403 标记；换 Key 保存时复位为 0）
    4: { label: 'statusDead', tone: 'danger' },
  },
  // fallback 也走目录键——默认字面量 Unknown 会以 channels.Unknown 原样漏到 UI
  { label: 'statusUnknown', tone: 'neutral' },
);

export function ChannelsTable({
  channels,
  providers,
}: {
  readonly channels: ReadonlyArray<AdminChannelRow>;
  readonly providers: ReadonlyArray<ProviderOption>;
}) {
  const t = useTranslations('channels');
  const tc = useTranslations('common');
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>{tc('name')}</TableHead>
          <TableHead>{t('provider')}</TableHead>
          <TableHead>Base URL</TableHead>
          <TableHead>{t('models')}</TableHead>
          <TableHead className="text-right">{t('weightPriority')}</TableHead>
          <TableHead className="text-right">{t('budget')}</TableHead>
          <TableHead>{tc('status')}</TableHead>
          <TableHead className="text-right">{t('failCount')}</TableHead>
          <TableHead className="w-64 text-right">{tc('actions')}</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {channels.length === 0 ? (
          <TableRow>
            <TableCell colSpan={9} className="h-24 text-center text-muted-foreground">
              {t('noChannels')}
            </TableCell>
          </TableRow>
        ) : (
          channels.map((c) => <ChannelRowItem key={c.id} channel={c} providers={providers} />)
        )}
      </TableBody>
    </Table>
  );
}

function ChannelRowItem({
  channel,
  providers,
}: {
  channel: AdminChannelRow;
  providers: ReadonlyArray<ProviderOption>;
}) {
  const t = useTranslations('channels');
  const tc = useTranslations('common');
  const [testing, setTesting] = useState(false);
  const meta = STATUS_META.get(channel.status);

  return (
    <TableRow>
      <TableCell className="font-medium">{channel.name}</TableCell>
      <TableCell className="text-muted-foreground">{channel.providerName}</TableCell>
      <TableCell>
        <code className="rounded bg-muted px-1.5 py-0.5 text-xs">
          {channel.baseUrlOverride ?? channel.providerBaseUrl}
        </code>
      </TableCell>
      <TableCell className="max-w-[200px] truncate text-xs text-muted-foreground">
        {channel.boundModels && channel.boundModels.length > 0
          ? channel.boundModels.map((m) => m.externalName).join(', ')
          : '—'}
      </TableCell>
      <TableCell className="text-right text-xs tabular-nums">
        {channel.weight} / {channel.priority}
      </TableCell>
      <TableCell className="text-right tabular-nums">
        <span className="font-medium">{formatMoney(channel.upstreamBudget)}</span>
      </TableCell>
      <TableCell>
        <StatusPill dot tone={meta.tone} label={t(meta.label)}>
          {channel.cooldownUntil ? (
            <span className="text-muted-foreground" title={channel.cooldownUntil}>
              {t('cooling')}
            </span>
          ) : null}
        </StatusPill>
      </TableCell>
      <TableCell className="text-right tabular-nums text-xs text-muted-foreground">
        {channel.failCount}
      </TableCell>
      <TableCell>
        <div className="flex items-center justify-end gap-1">
          <Button
            size="sm"
            variant="ghost"
            disabled={testing}
            onClick={async () => {
              setTesting(true);
              const { testChannelAction } = await import('../actions');
              const res = await testChannelAction(channel.id);
              setTesting(false);
              if (res.error) toast.error(String(res.error));
              else toast.success(t('connected', { ms: res.durationMs ?? 0 }));
            }}
          >
            {testing ? <Loader2Icon className="animate-spin" /> : <WifiIcon />}
            {t('test')}
          </Button>
          <EditChannelDialog channel={channel} providers={providers} />
          <ConfirmAction
            confirm={t('deleteConfirm', { name: channel.name })}
            action={async () => (await import('../actions')).deleteChannelAction(channel.id)}
            success={tc('deleted')}
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

// 校验消息走目录：schema 在组件内用 t 构造
function buildCreateSchema(t: ReturnType<typeof useTranslations<'channels'>>, tc: ReturnType<typeof useTranslations<'common'>>) {
  return z.object({
    providerId: z.coerce.number().min(1, t('providerRequired')),
    name: z.string().min(1, t('nameRequired')),
    apiKey: z.string().min(1, t('apiKeyRequired')),
    baseUrlOverride: z.string().optional(),
    models: z.string().optional(),
    weight: numericText({ message: tc('invalidInteger') })
      .refine((v) => Number.isInteger(v), tc('invalidInteger'))
      .refine((v) => v >= 1 && v <= 1000, t('weightRange')),
    priority: numericText({ message: tc('invalidInteger') })
      .refine((v) => Number.isInteger(v), tc('invalidInteger'))
      .refine((v) => v >= 0, t('priorityNonNegative')),
  });
}

export function CreateChannelDialog({
  providers,
}: {
  readonly providers: ReadonlyArray<ProviderOption>;
}) {
  const t = useTranslations('channels');
  const tc = useTranslations('common');
  const notify = useActionResult();
  const createSchema = buildCreateSchema(t, tc);

  type FormValues = z.input<typeof createSchema>;
  const form = useForm<FormValues>({
    resolver: zodResolver(createSchema) as never,
    defaultValues: {
      providerId: providers[0]?.id ?? 0,
      name: '',
      apiKey: '',
      baseUrlOverride: '',
      models: '',
      weight: '100',
      priority: '0',
    },
  });

  return (
    <FormDialog
      trigger={
        <Button>
          <PlusCircleIcon />
          {t('create')}
        </Button>
      }
      title={
        <>
          <NetworkIcon /> {t('create')}
        </>
      }
      titleClassName="flex items-center gap-2"
      description={t('createDescription')}
      submitLabel={tc('create')}
      formId="channel-form"
    >
      {({ run }) => (
        <ChannelForm
          form={form}
          onSubmit={(values: FormValues) =>
            run(async () => {
              const { createChannelAction } = await import('../actions');
              const res = await createChannelAction({
                ...values,
                providerId: Number(values.providerId),
                weight: Number(values.weight),
                priority: Number(values.priority),
              });
              if (!notify(res, tc('createFailed'), t('channelCreated'))) return false;
              form.reset();
              return true;
            })
          }
          formId="channel-form"
          providers={providers}
        />
      )}
    </FormDialog>
  );
}

function EditChannelDialog({
  channel,
  providers,
}: {
  channel: AdminChannelRow;
  providers: ReadonlyArray<ProviderOption>;
}) {
  const t = useTranslations('channels');
  const tc = useTranslations('common');
  const notify = useActionResult();

  const editSchema = z.object({
    name: z.string().min(1, t('nameRequired')),
    apiKey: z.string().optional(),
    baseUrlOverride: z.string().optional(),
    models: z.string().optional(),
    weight: numericText({ message: tc('invalidInteger') })
      .refine((v) => Number.isInteger(v), tc('invalidInteger'))
      .refine((v) => v >= 1 && v <= 1000, t('weightRange')),
    priority: numericText({ message: tc('invalidInteger') })
      .refine((v) => Number.isInteger(v), tc('invalidInteger'))
      .refine((v) => v >= 0, t('priorityNonNegative')),
    status: z.coerce.number().int(),
    rpmLimit: z.string().optional(),
    tpmLimit: z.string().optional(),
    upstreamThreshold: z.union([z.literal(''), moneyText({ message: t('nonNegativeAmount') })]).optional(),
  });
  type FormValues = z.input<typeof editSchema>;

  const form = useForm<FormValues>({
    resolver: zodResolver(editSchema) as never,
    defaultValues: {
      name: channel.name,
      apiKey: '',
      baseUrlOverride: channel.baseUrlOverride ?? '',
      models: channel.models ?? '',
      weight: String(channel.weight),
      priority: String(channel.priority),
      status: channel.status,
      rpmLimit: channel.rpmLimit === null ? '' : String(channel.rpmLimit),
      tpmLimit: channel.tpmLimit === null ? '' : String(channel.tpmLimit),
      upstreamThreshold:
        channel.upstreamThreshold === null ? '' : String(channel.upstreamThreshold),
    },
  });

  return (
    <FormDialog
      trigger={
        <Button size="sm" variant="ghost" title={tc('edit')}>
          <PencilIcon />
        </Button>
      }
      title={
        <>
          <PencilIcon /> {t('editTitle', { name: channel.name })}
        </>
      }
      titleClassName="flex items-center gap-2"
      description={t('editDescription')}
      submitLabel={tc('save')}
      formId="channel-edit-form"
    >
      {({ run }) => (
        <ChannelForm
          form={form as never}
          onSubmit={(values: FormValues) =>
            run(async () => {
              const { updateChannelAction } = await import('../actions');
              const res = await updateChannelAction(channel.id, {
                name: values.name,
                apiKey: values.apiKey?.trim() || undefined,
                baseUrlOverride: values.baseUrlOverride?.trim() || undefined,
                models: values.models?.trim() || undefined,
                weight: Number(values.weight),
                priority: Number(values.priority),
                status: Number(values.status),
                rpmLimit: values.rpmLimit === '' ? null : Number(values.rpmLimit),
                tpmLimit: values.tpmLimit === '' ? null : Number(values.tpmLimit),
                upstreamThreshold: values.upstreamThreshold === '' ? null : values.upstreamThreshold,
              });
              return notify(res, tc('saveFailed'), tc('saved'));
            })
          }
          formId="channel-edit-form"
          providers={providers}
          isEdit
        />
      )}
    </FormDialog>
  );
}

// 复用表单字段（创建 / 编辑）
function ChannelForm<T extends Record<string, unknown>>({
  form,
  onSubmit,
  formId,
  providers,
  isEdit = false,
}: {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  form: any;
  onSubmit: (values: T) => void;
  formId: string;
  providers: ReadonlyArray<ProviderOption>;
  isEdit?: boolean;
}) {
  const t = useTranslations('channels');
  const tc = useTranslations('common');
  return (
    <form id={formId} onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
      <FieldGroup>
        {!isEdit && (
          <Controller
            control={form.control}
            name="providerId"
            render={({
              field,
              fieldState,
            }: {
              field: { value: number; onChange: (v: number) => void };
              fieldState: { invalid?: boolean; error?: { message?: string } };
            }) => (
              <Field data-invalid={fieldState.invalid}>
                <FieldLabel>{t('provider')}</FieldLabel>
                <Select
                  value={String(field.value ?? 0)}
                  onValueChange={(v) => field.onChange(Number(v))}
                >
                  <SelectTrigger className="w-full">
                    <SelectValue placeholder={t('selectProvider')} />
                  </SelectTrigger>
                  <SelectContent>
                    {providers.map((p) => (
                      <SelectItem key={p.id} value={String(p.id)}>
                        {p.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {fieldState.invalid && <FieldError errors={[fieldState.error]} />}
              </Field>
            )}
          />
        )}
        <Controller
          control={form.control}
          name="name"
          render={({
            field,
            fieldState,
          }: {
            field: { value: string };
            fieldState: { invalid?: boolean; error?: { message?: string } };
          }) => (
            <Field data-invalid={fieldState.invalid}>
              <FieldLabel htmlFor="ch-name">{t('channelName')}</FieldLabel>
              <Input id="ch-name" {...field} />
              {fieldState.invalid && <FieldError errors={[fieldState.error]} />}
            </Field>
          )}
        />
        <Controller
          control={form.control}
          name="apiKey"
          render={({
            field,
            fieldState,
          }: {
            field: { value: string };
            fieldState: { invalid?: boolean; error?: { message?: string } };
          }) => (
            <Field data-invalid={fieldState.invalid}>
              <FieldLabel htmlFor="ch-key">{isEdit ? t('apiKeyKeep') : t('apiKey')}</FieldLabel>
              <Input id="ch-key" type="password" {...field} placeholder={isEdit ? '••••••' : ''} />
              {fieldState.invalid && <FieldError errors={[fieldState.error]} />}
            </Field>
          )}
        />
        <Controller
          control={form.control}
          name="baseUrlOverride"
          render={({ field }: { field: { value: string } }) => (
            <Field>
              <FieldLabel htmlFor="ch-url">{t('baseUrlOverride')}</FieldLabel>
              <Input id="ch-url" placeholder={t('overridePlaceholder')} {...field} />
            </Field>
          )}
        />
        <Controller
          control={form.control}
          name="models"
          render={({ field }: { field: { value: string } }) => (
            <Field>
              <FieldLabel htmlFor="ch-models">{t('modelsLabel')}</FieldLabel>
              <Input id="ch-models" placeholder={t('modelsPlaceholder')} {...field} />
            </Field>
          )}
        />
        <div className="grid grid-cols-2 gap-3">
          <NumberField
            control={form.control}
            name="weight"
            label={t('weight')}
            id="ch-weight"
            step="1"
            min={1}
          />
          <NumberField
            control={form.control}
            name="priority"
            label={t('priority')}
            id="ch-priority"
            step="1"
            min={0}
          />
        </div>
        {isEdit && (
          <>
            <Controller
              control={form.control}
              name="status"
              render={({ field }: { field: { value: number; onChange: (v: number) => void } }) => (
                <Field>
                  <FieldLabel>{tc('status')}</FieldLabel>
                  <Select
                    value={String(field.value ?? 0)}
                    onValueChange={(v) => field.onChange(Number(v))}
                  >
                    <SelectTrigger className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="0">{tc('enabled')}</SelectItem>
                      <SelectItem value="2">{tc('disabled')}</SelectItem>
                    </SelectContent>
                  </Select>
                </Field>
              )}
            />
            <div className="grid grid-cols-2 gap-3">
              <Controller
                control={form.control}
                name="rpmLimit"
                render={({ field }: { field: { value: string } }) => (
                  <Field>
                    <FieldLabel htmlFor="ch-rpm">{t('rpmLimit')}</FieldLabel>
                    <Input id="ch-rpm" type="number" {...field} placeholder={tc('default')} />
                  </Field>
                )}
              />
              <Controller
                control={form.control}
                name="tpmLimit"
                render={({ field }: { field: { value: string } }) => (
                  <Field>
                    <FieldLabel htmlFor="ch-tpm">{t('tpmLimit')}</FieldLabel>
                    <Input id="ch-tpm" type="number" {...field} placeholder={tc('default')} />
                  </Field>
                )}
              />
            </div>
            <Controller
              control={form.control}
              name="upstreamThreshold"
              render={({ field }: { field: { value: string } }) => (
                <Field>
                  <FieldLabel htmlFor="ch-threshold">{t('circuitThreshold')}</FieldLabel>
                  <Input id="ch-threshold" type="number" step="0.01" {...field} placeholder="0" />
                </Field>
              )}
            />
          </>
        )}
      </FieldGroup>
    </form>
  );
}

// ── 批量导入 ────────────────────────────────────────────────────────────────
export function ImportChannelsDialog() {
  const t = useTranslations('channels');
  const notify = useActionResult();
  const [text, setText] = useState('');

  return (
    <FormDialog
      trigger={
        <Button variant="outline">
          <UploadIcon />
          {t('import')}
        </Button>
      }
      title={
        <>
          <UploadIcon /> {t('importTitle')}
        </>
      }
      titleClassName="flex items-center gap-2"
      description={t('importDescription')}
      submitLabel={t('importSubmit')}
      onSubmitClick={async () => {
        let channels: Array<{
          provider: string;
          name: string;
          apiKey: string;
          models?: string;
          weight?: number;
          priority?: number;
        }> = [];
        try {
          const parsed = JSON.parse(text);
          if (!Array.isArray(parsed)) throw new Error('JSON array required');
          channels = parsed;
        } catch {
          toast.error(t('invalidJson'));
          return false;
        }
        const { importChannelsAction } = await import('../actions');
        const res = await importChannelsAction(channels);
        if (!notify(res, t('importFailed'))) return false;
        toast.success(t('imported', { count: res.created ?? channels.length }));
        setText('');
        return true;
      }}
    >
      <Textarea
        rows={10}
        value={text}
        onChange={(e) => setText(e.target.value)}
        className="font-mono text-xs"
        placeholder={
          '[\n  {"provider":"OpenAI","name":"openai-main","apiKey":"sk-xxx","models":"gpt-4o"}\n]'
        }
      />
    </FormDialog>
  );
}
