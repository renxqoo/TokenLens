'use client';

import { useState } from 'react';
import { Loader2Icon, PlusIcon } from 'lucide-react';
import { toast } from 'sonner';

import { Button } from '@ai-gateway/ui/components/ui/button';
import { Input } from '@ai-gateway/ui/components/ui/input';

import { createChannelAction } from '../actions';

const EVENTS = [
  { id: 'channel_disabled', label: '渠道禁用' },
  { id: 'billing_dead', label: '计费死单' },
  { id: 'reconcile_discrepancy', label: '对账差异' },
  { id: 'balance_low', label: '余额预警' },
  { id: 'context_overflow', label: '静默溢出' },
];

export function ChannelForm() {
  const [type, setType] = useState<'webhook' | 'email'>('webhook');
  const [name, setName] = useState('');
  const [url, setUrl] = useState('');
  const [secret, setSecret] = useState('');
  const [recipients, setRecipients] = useState('');
  const [events, setEvents] = useState<string[]>(['channel_disabled', 'billing_dead']);
  const [pending, setPending] = useState(false);

  return (
    <div className="space-y-3 rounded-lg border p-4">
      <div className="flex flex-wrap items-center gap-2">
        <Input className="max-w-48" placeholder="渠道名称" value={name} onChange={(e) => setName(e.target.value)} />
        <div className="flex gap-1">
          {(['webhook', 'email'] as const).map((t) => (
            <Button key={t} size="sm" variant={type === t ? 'default' : 'outline'} onClick={() => setType(t)}>
              {t === 'webhook' ? 'Webhook' : '邮件'}
            </Button>
          ))}
        </div>
      </div>
      {type === 'webhook' ? (
        <div className="flex flex-wrap gap-2">
          <Input className="max-w-96" placeholder="https://example.com/webhook" value={url} onChange={(e) => setUrl(e.target.value)} />
          <Input className="max-w-64" placeholder="HMAC 签名密钥（≥16 字符）" value={secret} onChange={(e) => setSecret(e.target.value)} />
        </div>
      ) : (
        <Input className="max-w-96" placeholder="收件邮箱（逗号分隔，≤20）" value={recipients} onChange={(e) => setRecipients(e.target.value)} />
      )}
      <div className="flex flex-wrap gap-2">
        {EVENTS.map((ev) => (
          <Button
            key={ev.id}
            size="sm"
            variant={events.includes(ev.id) ? 'default' : 'outline'}
            onClick={() => setEvents((cur) => (cur.includes(ev.id) ? cur.filter((x) => x !== ev.id) : [...cur, ev.id]))}
          >
            {ev.label}
          </Button>
        ))}
      </div>
      <Button
        disabled={pending || !name || events.length === 0}
        onClick={async () => {
          setPending(true);
          const res = await createChannelAction({
            name,
            type,
            config:
              type === 'webhook'
                ? { url, secret }
                : { recipients: recipients.split(/[,，\s]+/).filter(Boolean) },
            events,
          });
          setPending(false);
          if (res.error) {
            toast.error(res.error);
            return;
          }
          toast.success('渠道已创建');
          setName('');
          setUrl('');
          setSecret('');
          setRecipients('');
        }}
      >
        {pending ? <Loader2Icon className="size-4 animate-spin" /> : <PlusIcon className="size-4" />}
        创建渠道
      </Button>
    </div>
  );
}
