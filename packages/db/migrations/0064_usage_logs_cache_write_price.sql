-- 0064：usage_logs 补缓存写单价快照列（0063 遗漏——计价审计与报表对称落列）。
alter table "usage_logs" add column if not exists "cache_write_price" numeric(38, 18) not null default '0'
