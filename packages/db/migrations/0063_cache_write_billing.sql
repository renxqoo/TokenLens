-- 0063：cache_write 计费（系数体系）——
--   model_mappings.cache_write_price：官方缓存写单价（元/百万 token；0 = 该模型不收缓存写费）
--   usage_logs.cache_write_tokens：计量落列（限额口径与审计）
-- 公式变更（domain rating/pricing）：
--   uncached = input − cached − cacheWrite（三段互斥；夹非负）
--   amount 分量 += cacheWrite × cacheWritePrice × 系数
--   预扣贵价 = max(input, cacheInput, cacheWrite)（Anthropic 写 1.25×/2× 可超输入价）
alter table "model_mappings" add column if not exists "cache_write_price" numeric(38, 18) not null default '0'
--> statement-breakpoint--
alter table "model_mappings" add constraint "model_mappings_cache_write_price_check" check ("cache_write_price" >= 0)
--> statement-breakpoint--
alter table "usage_logs" add column if not exists "cache_write_tokens" bigint not null default 0