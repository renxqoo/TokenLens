-- 0065：汇率追溯与目录定价 provenance——
--   fx_rates：USD→CNY 汇率追加表（只增不改；自动拉取与手动覆盖各落一行，对账真相）
--   system_configs：运营配置 KV（目录汇率运行态：模式/点差/覆盖位/缓存——真相恒在 fx_rates）
--   usage_logs.fx_rate / fx_rate_id：请求时点生效汇率快照（账单级追溯：
--     这笔账 = tokens × 价格快照 × 系数，且当时汇率一查便知；旧行 NULL = 历史无此口径）
create table if not exists "fx_rates" (
  "id" bigserial primary key,
  "base_currency" varchar(8) not null default 'USD',
  "quote_currency" varchar(8) not null default 'CNY',
  "rate" numeric(38, 18) not null,
  "source" varchar(16) not null,
  "mode" varchar(8) not null default 'auto',
  "operator_admin_id" bigint,
  "fetched_at" timestamptz not null default now()
)
--> statement-breakpoint--
alter table "fx_rates" add constraint "fx_rates_rate_check" check ("rate" > 0)
--> statement-breakpoint--
create index if not exists "fx_rates_fetched_at_idx" on "fx_rates" ("fetched_at" desc)
--> statement-breakpoint--
create table if not exists "system_configs" (
  "key" varchar(64) primary key,
  "value" jsonb not null,
  "updated_at" timestamptz not null default now(),
  "updated_by_admin_id" bigint
)
--> statement-breakpoint--
alter table "usage_logs" add column if not exists "fx_rate" numeric(38, 18)
--> statement-breakpoint--
alter table "usage_logs" add column if not exists "fx_rate_id" bigint
