# CHANGELOG —— 修复与演进日志

> 本文件是修复记录 / 审计历史 / 施工资留痕的**唯一归档地**（自 AGENT.md 迁出——规则书只留规范）。
> 工作规则见 [AGENT.md](./AGENT.md)；扣款链路唯一真相见 [docs/billing-flow-deep-dive.md](./docs/billing-flow-deep-dive.md)。
> 条目按时间倒序、保留原始记录不重写。




---

## §19 静默溢出告警接线（P1#4 收口，2026-08-20）

ai 包 success 事件的 contextOverflow 旗标此前无人消费——现三段接通：
①事件补 `model`（仅溢出时携带，告警定位用）；②网关 `wireContextOverflowAlert`
订阅 onEvent → notify_outbox 入箱（事件即事实；dedupe `context-overflow:{requestId}`
幂等；入箱失败静默——告警旁路不反噬请求路径）；③NOTIFY_EVENTS 词表 + 通知渠道
UI 下拉加 `context_overflow`（静默溢出），运营订阅后经 worker 既有 webhook/email
通道投递。语义不变：溢出不翻转成功、不影响计费（计费按供应商 usage 是正确口径）。
顺带加固：admin-api 测试清理链在 provider 级联删渠道前先删 channel_recharges
（共享库残留曾卡死 21 个套件的 teardown）。

## §18 模型市场统一 + 汇率追溯全链（2026-08-20，分支 feat/cache-write-and-catalog）

**用户拍板的四项设计决策**：① 账本恒单币种（CNY），换算只发生在导入边界；
② 汇率自动拉取为主（ECB/frankfurter 无 key 源）+ 手动覆盖 + 点差（覆盖值不叠
点差——手动值自带运营判断）；③ models.dev 活拉（api.json），快照只做兜底；
④ 追溯要到请求级——任何一笔账可答「用了什么价、当时汇率多少」。

**多币种口径（资金正确性）**：计费核心零改动（GATEWAY_CURRENCY=CNY →
assertCurrency 守卫 → pricing 全元/百万 token）；USD 只是目录参考币。
OpenRouter 目录价为**每 token 美元**——映射层归一 ×1e6 到每百万（与 models.dev
同口径），否则预填差 1e6 倍（实现中发现并修正的真 bug）。顺带修掉 §17 WS2 的
单位漏洞：裸种子导入曾把美元价当人民币存（7× 贱卖风险，草稿态缓解）——该通道
整体退役（铁律 8），统一走换算预填 + 人工确认。

**汇率三层结构（对账三问各有归属）**：
- `fx_rates` 追加表（0065 迁移，只增不改）：auto 行（ecb 拉取）与 manual 行
  （覆盖，含操作人）——「当时什么汇率、从哪来、谁改的」查表即答
- `system_configs`（catalog_fx）：运行态缓存（mode/buffer/override/当前值）；
  懒拉信任表而非缓存（表无行即触发拉取——配置缓存可能失真）
- 定价审计 provenance：每次导入记「目录原价 × fx（rateId/base/effective/来源/
  时间）→ 预填 → 提交」，预填由服务端重算（前端不传），人工改过预填一目了然

**请求级追溯**：usage_logs 新增 fx_rate/fx_rate_id（0065）——网关报价时点经
repos.fx.current()（60s 进程缓存）快照进收据（ReceiptParams.fx），结算投影落列。
这笔账 = tokens × 价格快照 × 系数 + 当时基准汇率，一查全有。历史行 NULL = 上线
前无此口径。

**模型市场重构（多源货架）**：CatalogSource 分两类——channel（OpenRouter：真实
上游，导入建 provider/渠道/绑定并上架）与 reference（models.dev：行业字典，
导入落草稿 status=1 审批制，不建渠道）。免费过滤从代码硬过滤降为 UI 筛选；
三态 diff（new/same/price_up/price_down，换算同币比价 ±5% 带宽抗噪声）+ 漂移
百分比 + 「跟进涨价（防亏）/跟进降价（让利）」批量勾选 + 上游消失检测（绑定到
本源渠道且目录已无）。UI：动态源 Tab、汇率条（改覆盖/点差/强刷）、双币展示
（目录 $ + 预填 ¥）、写价列、价格溯源时间线弹窗（GET /v1/model-catalog/
price-history?externalName=）。

**分层纪律**：admin-api 零 SQL 铁律全程维持——fx 读写与溯源查询下沉 repository
（FxRepository.insertRate/readConfig/upsertConfig + AuditLogRepository.
listCatalogPriceHistory jsonb 包含查询）；路由注册顺序陷阱：字面段
price-history 必须先于 :sourceId 注册。

---





---

## §17 三工单落地：cache_write 计费（系数体系）+ 目录导入 + CI 流水线（2026-08-20，分支 feat/cache-write-and-catalog）

**WS1 cache_write 计费接入（用户决策：走系数体系加成）**：
- 迁移 0063/0064：model_mappings.cache_write_price + usage_logs.cache_write_tokens/
  cache_write_price（0/缺省 = 与输入价同值——cacheInputPrice 同款约定，未配置
  不得让写 token 逃逸计费）
- rating 公式：三分段互斥（uncached = input − cached − write，夹非负）、
  写分量 × cacheWritePrice × 系数；预扣贵价 = max(input, cacheInput, cacheWrite)
  ——Anthropic 写价（1.25×/2×）可超输入价，不上贵价会少押
- 全链透传：报价候选/收据/结算/usage_logs 四处快照 + admin 价格字段（表单/
  路由/服务）+ gateway 端口。pipeline 真结算断言：1000 输入（200 读 + 100 写）
  → 钱包实扣 0.001025 元分毫不差
- **顺带修复存量口径缺陷**：Anthropic input_tokens 不含缓存部分（OpenAI 口径含）
  ——claudeUsageToUsage 补齐为总输入；旧口径在缓存价 < 输入价时少收缓存命中的
  未缓存分量

**WS2 模型目录导入（审批制）**：POST /v1/models/import——种子条目校验（单批
≤100）、externalName 重复跳过不覆盖定价、**一律 status=1 草稿态**（价格属资金
语义，复核后人工上架）、dryRun 预览、审计落档。配套用例 5 组（幂等/边界/防御）。

**WS3 CI 流水线**：.github/workflows/ci.yml——push/PR 触发，PG16+Redis7 服务
容器（每 PR 独享库，无共享竞态），四门（turbo typecheck/lint/build/test）+
双包覆盖率门禁（ai 90/85、admin-api 90/85）+ 报告归档。E2E 独立通道不进 CI
（与本地约定一致）。

**运维注记**：本机磁盘满（.turbo 缓存 13G）已清理——turbo 缓存可随时删。

---

## §16 pi-ai 资产吸收收口（2026-08-20，分支 refactor/ai-package-v2 第二批）

调研清单「尚未吸收项」全部落地（覆盖率门禁复测 94.9/85.1/93.3/96.8，459 单测全绿）：

1. **模型元数据同步**（models.dev 单一上游，离线回落 pi-ai 快照）：
   `pnpm --filter @ai-gateway/ai model-meta` 生成 (a) model-meta.generated.ts——
   1689 条 provider:model/裸名 → contextWindow（静默溢出判定数据源，入包发版）；
   (b) scripts/output/model-catalog-seed.json——981 模型四维成本/能力位目录种子
   （admin 导入审批制：价格属资金语义禁止自动生效，接入面挂模型目录工单）。
2. **BPE 真分词器**（js-tiktoken 纯 JS）：估算器主路径（模型族解析 o200k/cl100k，
   pi-ai 同款策略），启发式兜底（无模型名/超长降级 20 万字符/编码异常）；
   gateway 预扣与收据估算调用点已带 model 走精确路径。CJK 约 1 token/字
   （旧启发式 0.7）——预扣口径更保守（高估安全方向）。
3. **vendor 档案扩充**（1→7 家）：deepseek/moonshot/together/nvidia/xai/zai
   全部以 pi-ai detectCompat 生产兼容矩阵为 basis（ignore=供应商拒收参数、
   map=供应商要求参数名；moonshot/together/nvidia 把 max_completion_tokens
   映射回 max_tokens）。
4. **静默溢出兜底**：detectSilentOverflow（usage.input > contextWindow，窗口
   来自 models.dev 快照）→ success 事件 contextOverflow 旗标 + 告警日志。
   语义定位=可观测不翻转成功（计费按供应商 usage 是正确口径；窗口元数据可能
   滞后，误杀好响应代价高于漏报）。
5. **cache_write 数据捕获面**：Usage.cacheWriteTokens（Anthropic 5m+1h 两档
   合计、cache_write_tokens 方言归一、claude 双向流/非流式携带、编码方向还原
   claude 原生字段名）。计费消费（费率卡 cache_write 价位+rating 公式）仍属
   独立资金工单——本批只让数据可见。
6. **修复存量缺陷（特征化再暴露）**：Anthropic 流式 usage 从未发出——
   message_delta.usage 按 Claude 语义只带 output_tokens（input 在 message_start），
   claudeUsageToUsage 严格双字段解析永远拒绝它 → 流式计费全走估算。改为宽松
   读取（output 直取，完整形态才覆盖 input/缓存侧）。

**仍未做（明确留白）**：协议覆盖广度（pi-ai 9 传输/35 provider 预置元数据）——
特性而非缺陷，按需另立；模型目录 admin 导入端点——种子文件已就绪，接线挂工单。

---

## §15 packages/ai v2 重构完成（2026-08-20，分支 refactor/ai-package-v2，方案见 docs/plan-ai-package-v2.md）

P0–P5 全部落地：机制链拆解（create-ai 768→273 行，pipeline 八模块各 ≤128 行）、
契约分粒度（五能力件 + defineAdapter 组合器，Azure 改组合式）、vendor 全链
（providers.vendor 迁移 0062 + 档案库 + mergeParamRules + admin 下拉）、任务词表
收敛（删 ai 死模块 descriptors，domain GENERATION_KINDS 唯一真相 + 跨包一致性
测试）、覆盖率门禁 90/85（实测 94.8/85.1/93.2/96.8，449 单测 + gateway e2e 32/32）。

**施工中发现并修复的 4 处生产缺陷**（特征化测试暴露；均属「mock 上游不校验
形状所以一直没拦住」家族）：
1. **模态族寻址错路**：gateway 从不传 ctx.endpoint，create-ai 兜底 'chat'——
   embeddings/images/audio/rerank/moderations 生产路径全被发往 /v1/chat/completions。
   修复：RequestCtx.endpoint 必填 + 全链显式传递 + 删 body.inferenceKind 双轨。
2. **multipart 文件丢失**：body.upstreamForm 从未拆包，JSON.stringify(wrapper)
   把 FormData 静默序列化成 {}——images/edits、audio/transcriptions、
   audio/translations 的文件字节到不了上游。修复：chat 路径拆包直传 + model
   重写进表单 + normalizeRequest FormData 直通底线。
3. **取消丢失**：fetchUpstream 对已中止信号只挂 addEventListener（abort 事件
   不回放）——DNS 解析期间/派发前的取消被丢失、请求照发。修复：入口显式拒绝
   + 监听前置（SSRF 校验错误仍原样上抛）。
4. **契约形状不齐**：openai-compatible planRequest 内联类型把 Endpoint 窄化缺
   video/music；anthropic/gemini/bedrock normalizeRequest 缺 rules 参。

**其他**：overflow 错误库（新码 context_overflow：不重试/不跳闸/不换渠/原码
透传）；usage Mistral 方言 + 修复嵌套 compatible 吞冲突信号隐患；vertex-ai
fetch 注入点提构造器（原注释声称可注入但生产不可达）；e2e-kit.settleAll 竞态
容忍（§5.7）；e2e-worker OTEL 配置缺失修复。

**决策门结论（cache_write）**：Anthropic cache_creation_input_tokens（含 1h 档）
当前完全未计量未计费——cache read 已正确归一。属跨域资金工单（db 费率卡 +
rating 公式 + wallet 联动），未混入本次重构，挂独立待办。

**实施偏差**：vendor profile 首批仅含已验证条目（openai: max_tokens→
max_completion_tokens，basis 必填防自造规则）——计划原定 8 家在 new-api/pi-ai
中均无内置参数删除实证，编造规则的风险大于收益，机制完整、内容待实测补充。

---

## §14 竞品深度对比 + packages/ai v2 重构方案定稿（2026-08-20，docs/plan-ai-package-v2.md）

与 new-api（本地全量代码）及 @earendil-works/pi-ai 深度对比后定稿（留痕）：

- **结论**：传输引擎保留自研，不引入 pi-ai/官方 SDK 运行时依赖（pi-ai 是 agent 客户端
  抽象——统一 Context/SSE 全量解析/请求体重构造，与透明中继正交）；定向吸收资产：
  overflow 错误模式库、usage 方言、models.dev 元数据上游、vendor profile 词汇表。
- **定稿**：docs/plan-ai-package-v2.md（P0–P5，约 4 周）——机制链拆解 create-ai.ts(768 行)、
  契约分粒度（5 能力件 + defineAdapter 组合器）、Vendor Profile 体系（新厂商零代码接入）、
  任务族词表泛化；P1 先修正确性欠账。
- **施工中发现的生产欠账（P1 待修）**：① gateway upstream-adapter 不传 ctx.endpoint，
  模态族（embeddings/images/audio/rerank/moderations）上游寻址生产兜底成 'chat'；
  ② 上下文溢出错误未分类（可重试/换渠语义错误）；③ usage 方言缺口（Anthropic 1h
  缓存/Mistral/Google thoughtsToken）；④ Usage 无 cache_write 维度——决策门：先核查
  真实 Claude 渠道流水 usage.raw，若漏计则开独立资金工单。

---

## §13 生产终审修复：3 资金 HIGH + 2 安全 HIGH + 6 MEDIUM（2026-08-19，全库 DB 对账 + 三路审查）

三轮独立审查（资金数学/安全面/测试体系）+ 全库 13k 授权对账（双分录平衡、
余额链、in_flight=Σactive、无悬挂/超结——全部零违例）后修复：

- **H1 0 元结算死信**：payg settle(consume=0) → InvalidAmountError 不属死信家族
  → 10 轮重试全败 dead + 预扣冻结。修复：consume≤0 改走 wallet.release 全额释放。
- **H2 流式终态漏收**：signal(succeeded) 瞬时失败被吞且续租已停 → recover 释放
  = 200 已交付免费单。修复：signalSucceededWithRetry 退避重试（5 次/500ms 起），
  重试期间续租不停；非流式同用（耗尽 503 不交付）。
- **H3 订阅超池死信**：实际用量超预扣上界 → trySettleQuota 红灯 → 冲突重试耗尽
  dead + 预占冻结（PAYG 有 D3 降级、订阅无对称）。修复：settleQuotaBounded
  （FOR UPDATE 锁行 + SQL least/greatest 钳制核销到池容量），差额记损不红灯。
- **S1 JWT 分支无爆破锁**：伪造 JWT 无限 401 不计失败 + request_logs 未认证写
  放大。修复：JWT 分支前置 ipGuard.isLocked + UnauthorizedError 计失败
  （Redis 故障 fail-closed 503 同口径）。
- **S2 App-JWT 绕过用户帽**：dims 里 user 维仅静态 Key 在列，JWT 挂的是用户
  自建 scope（上限 100 万 RPM）。修复：凭证维（key:/app:/pg:）+ 用户维无条件
  并罚；generation/submit 同口径。
- M：渠道预算熔断 JS 字符串比较（'9'<='10' false）→ SQL 侧 numeric 比较；
  三处 buildReceipt 补 appId（usage_logs 归属失真）；authorize 重放校验
  existing.status；billedBy 改随 planAmount（消灭 plan&&subId=null 矛盾行）；
  webhook 投递接 assertSafeUrl 硬门（WORKER_WEBHOOK_ALLOW_LOCAL_URL dev 双门）；
  404 candidates 路径补 releaseTpm。

回归钉死：settlement +3（0 元/超池/billedBy）、pipeline +3（dims 并罚/重试纯编排/
流式抖动自愈）、app +2（JWT 锁）、worker notify-ssrf +3。regress 31/31 + gateway
E2E 32/32 绿。已知未修（记录在案）：无 CI 流水线、资金包无覆盖率门禁、
worker reconcile 哨兵零测试——上线后第一迭代。

---

## [2026-08-20] 文件名/包名/服务名清除 -v2 后缀（b4c1ae8）

v1 退役后 "-v2" 后缀失去意义，全仓统一去除：
- 四 app 目录 `git mv`：gateway-v2 / worker-v2 / client-api-v2 / admin-api-v2 → gateway / worker / client-api / admin-api（历史保留）；包名 `@ai-gateway/*-v2` → `@ai-gateway/*`；根 scripts 同步（删与 dev 重复的 dev:v2，dev:client-api-v2 → dev:client-api 等）
- compose 服务名与内部主机名一致更新（nginx upstream → gateway:8083；OAUTH_API_BASE / CLIENT_API_BASE / ADMIN_API_BASE）
- **修复 compose.yml v1 删除事故残块**：孤立的 `redis:` 键下挂着 v1 gateway 服务尾块（8787 健康检查）；gateway 服务补回 8083/readyz 健康检查 + 30s SSE drain 宽限 + 多副本注释
- `docs/billing-flow-deep-dive-v2.md` 转正为 `billing-flow-deep-dive.md`（描述已删 v1 代码的旧历史文档随之删除，头部交叉引用改为唯一真相口径）
- 61 个文件注释/文档/脚本引用替换；pnpm-lock importers 重建。验证：regress 31/31 + compose YAML 结构校验（16 服务、redis 唯一、主机名全一致）

---

## §12 v1 正式退役（2026-08-20，用户拍板）

删除范围（`git rm` 353 文件）：
- 四应用：apps/gateway、apps/worker、apps/client-api、apps/admin-api
- v1 账本：packages/ledger（**ledger-core 保留**——db schema/迁移依赖，非 v1 专属）
- 根脚本清理：dev:client-api/dev:admin-api/start:* v1 六条；regress filter 去除 v1 排除
- v1 专属共享模块下线：http cache.ts（v1 路由缓存失效——v2 网关直读 DB 无缓存）、
  http csrf.ts（v2 纯 Bearer 无 Cookie）、identity login-throttle.ts（v1 fail-open 登录
  限流——v2 用 core fail-closed 守卫）、wallet metering 子导出（v1 计费公式——v2 在 domain rating）
- admin-api 的 bumpRouteCache/invalidateKeyAuthCache 十二处调用全部拆除（失效的是
  v1 网关的 60s 缓存——对 v2 是无效操作）
- compose：v1 四服务块删除；console-client/console-admin 指向 client-api:8081 /
  admin-api:8082；**nginx upstream 切 gateway:8083**（生产入口正式切换）
- .env.example：30 行 v1 专属键清理
- Dockerfile.server 注释更新（v2 五应用）

**保留**：trace-receiver（用户决策）、ledger-core、全部迁移文件。

**过程中抓修两个真 bug**：
1. 4xx 透传缺收尾（第三轮透传改造引入）：透传路径未归还 TPM 预扣、未发
   request.failed 三路释放——上游 4xx 后预扣滞留到 TTL。已补齐收尾。
2. worker 模块级自启动守卫脆弱：`NODE_ENV !== 'test'` 在部分测试运行器形态下不可靠
   （实测全局 vitest 不设 NODE_ENV）——e2e 动态导入 worker 入口即幽灵自启消费共享库。
   已加显式 `WORKER_NO_AUTOSTART=1` / `VITEST` 双守卫 + liveWorkerInstances 实例登记
   探针（排障利器）+ e2e-worker 测试 opt-out。

验证：全仓门禁 31/31（v1 删除后任务数自然下降）+ gateway e2e 7 文件 32 例全绿 +
双前端 production build 通过。运维注意：**支付回调 URL 必须指向
/v1/payments/notify/:provider**（EPAY 后台 + Stripe webhook）。

---

## §11 v1 退役验收：对位缺口全部补齐（2026-08-19/20，R 系列四波）

删 v1 前的深度验收发现「v2 已全覆盖」不成立（字段级形状/worker 后台循环/前端消费契约
三大盲区，含 v1 修过的 bug 回归）。本批在 feat/remove-v1 分支全部补齐 + 测试钉死，
全仓门禁 32/32 绿。

### Wave 1 worker 资损防线（v1 四循环对位）
- 通知投递 runNotifyDispatch（webhook HMAC + email + 3 次退避终态）
- 周期对账哨兵 runReconcile（wallet verifyInvariants + reconcile_discrepancy 入箱）
- 分区维护 trace_spans + request_logs（缺位 = 窗口后插入失败）
- TPM 回填 backfillTpm（core limiter 新方法：释放预占 + actual 记账 + projected 幂等；
  缺位时成功请求预占只能等 TTL——TPM 越用越紧）
- settlement 钩子 onSettled/onDead（事务外 best-effort：TPM 回填 + balance_low/billing_dead 入箱）
- 健康端点 livez/readyz/health(令牌)；WORKER_HEALTH_PORT=0 测试隔离

### Wave 2 前端联动（v2 自身 bug，双轨别名兼容）
apps DELETE/:id 与 rotate-secret 别名；keys 返回 key=plaintext；redeem history id；
org 列表补 id/subscriptionName/remainingAmount + list/total 信封；订阅列表「生效中个人
订阅置顶」+ remainingAmount/renewPrice/planPrice/remainingValue；金额字段 number|string
双收；BODY_LIMIT 8MB（playground 3.2MB 白名单上限可工作）；admin plans/:id/grant 别名；
models billingPolicy 全链路（schema→service→repo insert/回显）。

### Wave 3 安全与语义
- 登录锁 DoS 回归修复（用户面+管理面）：锁维度 (email,ip)、正确密码永远放行并清零、
  错误密码在已锁后 429+Retry-After（v1「02 修复」语义恢复）
- 注册恒两步 fail-closed（无 SMTP=503 绝不单步建号；EMAIL_CODE_REQUIRED 只管登录）
- 固定窗口计数器 Lua 原子化（v1 修过的无 TTL 键坑不重蹈）
- keys/apps 配额 advisory lock + 100/100；rotate-secret FOR UPDATE 行锁
- 订单先落库后建渠道（占位单号 + attach 回填——渠道会话无 DB 行的资金黑洞封死）
- 订单详情端点 + failureReason；支付回调 v1 旧路径别名（epay GET/stripe POST）
- page_size 别名 ×6 + wallet nextCursor；me 补 rateCard/status/rpm/tpm/lastLoginAt；
  usage/summary 按日聚合；个性化定价 /v1/pricing/personal（费率卡系数×到手价）+ contextLength
- 用户面审计（key/app/org/密码/昵称）+ 管理面登录事件审计；redeem revoked 码区分；
  verify schema 收紧（uuid+6 位码）；通知渠道 type 冻结；CORS Max-Age；FE 密码提示 10 位

### Wave 4 测试（19 个新用例）
- client-api frontend-contract.test（11 例：apps 动词/keys 字段/org 形状/订阅置顶/
  number 金额/page_size/订单详情/回调别名/注册 fail-closed）
- worker parity-loops.test（5 例：webhook 签名/无渠道终态/TPM 回填幂等/健康端点/balance_low dedupe）
- gateway v1-parity.test（3 例：livez/engines 别名/SSE x-request-id）
- admin coverage-gaps +2（plans grant 别名含现金口径语义/billingPolicy 落库回显）
- 既有测试按新语义更新（注册两步/登录锁正确密码放行/aff 归因改 service 直调）

### 终审轮（2026-08-20，三路深度复审：上轮补齐验证 + 新 bug + fail-open 全库扫描）

三路并行审计（client/admin+gateway/worker+共享包）发现 7 个高危并当日全部修复：

- **P0 SSRF 硬门缺失**：gateway/worker 的 ALLOW_LOCAL_URL 无 NODE_ENV 生产联锁
  （admin-v2 有）——生产误配 env 即可打内网/元数据地址。已补双门。
- **plans grant 别名不幂等**（上轮自引入）：operationId 带 Date.now() → 重试双扣现金。
  已改 operationId(c)（尊重 idempotency-key 头）。
- **admin 登录 IP 桶塌缩**（上轮漏网）：路由层 socketAddress null → 30 次失败锁死全进程
  管理员。已注入真实 socket 地址。
- **每用户 RPM/TPM 限额完全未执行**（上轮漏网）：users.rpm/tpm_limit 管理端可设但无消费方，
  v1 的 DEFAULT_USER_RPM 兜底也没了。已恢复：凭证级 > 用户级 > 全局兜底（60RPM/1M TPM）
  三级合成（effectiveLimit），静态 Key/app_jwt/playground 三分支全覆盖 + 表驱动测试。
- **playground JWT 不查属主状态**：封禁用户存量 JWT 在 TTL 内照用。已加 findActiveUserById
  核验 + 封禁 401 测试。
- **Stripe 两处资金边**（上轮自引入）：v1 别名 webhook 恒 200（fail 不重试=钱收了不入账）→
  改 400-on-fail；attach 失败被吞 + client_reference_id 丢弃 → 回退锚定位（merchantOrderId）。
- P1 批：summarizeByDay bigint→number、渠道下单失败关单+502、register 429 Retry-After、
  jwtVerify HS256 白名单、2FA 验证成功审计、org remainingAmount clamp、planPrice coalesce、
  backfillTpm 零额也释放预占、worker compose healthcheck、SSE X-Accel-Buffering:no
  （nginx 前置反代缓冲卡流——v1 也缺的运维地雷）+ connection:keep-alive。

fail-open 全库扫描结论（B 表 21 项）：v2 资金/鉴权主干全部 fail-closed（限流器/爆破锁/
免费日限/计数器/会话/OAuth state 默认关）；可接受的 best-effort（告警入箱/遥测/缓存失效）
按 P2 记录在案；v1 遗留 fail-open（login-throttle/CSRF/cache 失效）只被 v1 消费——删 v1
时随之消亡。终审后全仓门禁 32/32 绿（新增 final-hardening.test 2 例）。

### 第三轮独立终审 + 兼容层拆除（2026-08-20，用户决策：不留任何 v1 双轨）

第三路独立代理扫描抓出 4 个全新 HIGH 真 bug（当日全修）+ MEDIUM 批：

- **appId 未传 billing**（资金 bug）：App-JWT 的订阅绑定丢失 → 全部错走 PAYG。
  run-chat/submit/receipt 全链补齐 appId + credentialType（jwt/key）。
- **音频二进制返回 {}**：rawBody 在适配层被丢——audio_speech 端点坏。三层透传修复
  （adapter→ChatResponse binary 形态→encodeResult 原样字节回传）。
- **上游 4xx 不透传**：客户端错误被吞成 502 且遍历全部 fallback（白耗上游调用与预占）。
  4xx 原码返回 + 退出候选循环；纯渠道耗尽恢复 v1 的 503 no_available_channel。
- **JWT scope.models 白名单缺失**：v1 企业 App 限模型能力丢失。/oauth/token 全量签
  scope → middleware 解析 allowedModels → chat/submit 预扣前 403 + /v1/models 列表过滤。
- MEDIUM：requestSummary 恢复（截断 model/stream/max_tokens）、model NUL 守卫、
  billing_dead 补 userId、/oauth/token per-clientId 爆破锁（IP 轮换绕不过）、
  models/:model 的 Gemini 前缀剥离。

**兼容层全部拆除（用户拍板「不要兼容老代码的逻辑」）**——v2 只剩单一正位形态，
前端/api-client 同步改直连：apps disable/rotate 正位动词（DELETE/rotate-secret 别名删）、
keys 明文只回 plaintext（key 字段删）、orgs 只回 orgId/planName/rows 信封（id/
subscriptionName/list 删）、redeem 只回 codeId、支付旧回调路径删（**运维清单：EPAY 后台
与 Stripe webhook 须指向 /v1/payments/notify/:provider**）、admin grant 只走
/v1/subscriptions/:id/grant、分页只认 page+limit（page_size 删，api-client buildListQuery
改发 limit）、Paginated 只读 rows。contract 测试全部改为断言正位 + 旧别名 404。

**三个留档项全部补齐（同日）**：
- **限流并罚制**：admitKey 改多维原子（limiter.checkAll/reserveTpmAll——core 原语已在，
  此前未用）：凭证维 + 用户维各自生效任一超限即拒（高限额 Key 不可越用户帽）；模型维
  TPM 预占（主+fallback mappingId 一并占，v1 reserveFallbackDims 语义）。旧 effectiveLimit
  择优制删除；final-hardening 测试钉死「用户帽 2 + 凭证 1000 → 第 3 次被用户维拒绝」。
- **/v1/models 协议形状**：anthropic-version 头 → Anthropic 列表形、x-goog-api-key →
  Gemini models/ 形（v1 对位移植）。
- **v1beta Gemini 原生入口**：/v1beta/models/:model:generateContent|:streamGenerateContent
  上线——转换函数本就在共享包 packages/ai（与出站共用一套真相），只差路由接线；
  鉴权/白名单/计费/限流与全部端点同管线。至此 v1 gateway 已知功能缺口清零。
  前后端 production build 通过，全仓门禁 32/32 绿（v1-parity 6 例）。

### 遗留（复验后处理）
- playground JWT 不带 rateCardId：v2 buildQuote 按 userId 查费率卡——已个性化，无需修
- ~~v1beta Gemini 原生入口未移植~~（2026-08-20 第三轮后续已补：见下方三留档项补齐段）
- nginx 切 v2 + 删 v1 待用户最终确认（本分支已具备验收条件）
- **支付回调 URL 迁移（兼容层拆除后成为强制项）**：EPAY 后台 notify_url 与 Stripe
  webhook 端点必须指向 /v1/payments/notify/epay|stripe——旧路径已 404，漏配=充值不入账

---

## §10 生产上线前资金安全大审查（2026-08-19，D 系列刷费用专项）

用户指令：review v2 找 bug/逻辑/安全/性能/扣款资金问题 + 补 E2E 保生产 0 bug 0 资金问题 +
重点封「对接上游 LLM 让用户无限刷平台费用」。四路并行审计（client-api/admin-api/gateway 路由/
worker+任务）+ 资金主链路人工精读，全部发现即日修复并补测。

### 刷费用向量（用户重点，全部封死 + E2E 钉死）

- **D1 输出估算收费**（最狠的漏收面）：流式取消/完成但上游不给 usage 时输出原按 0 计费
  ——「拉满输出再掐线」「用忽略 include_usage 的供应商」两个白嫖面。修复：SseScanner 累计
  规范形 delta 内容（4MB 上界）→ relayStream done 事件 → ai success 事件 → 网关收据用
  校准估算器（estimateTextTokens，与输入同一 CJK 权重）估输出 token；非流式缺 usage 用
  estimateOutputTokens(resBody)。估算仍走 estimatedFor 归属白名单（client_disconnect /
  usage_missing_completed / usage_missing_nonstream），validateReceipt 结构不变。
- **D2 max_tokens 转发钳制**：预估敞口按 exposureCap（32768）封顶但转发体原样透传——
  客户端声明 100 万输出上限时实际可产出 >> 预估。修复：clampForwardedOutputLimit 把
  max_tokens/max_completion_tokens 压到 口径/n（不注入未声明值——o 系列兼容）。
- **D3 PAYG 超额兜底**：实际 > 预留 且余额不足时 #over 补充授权抛错 → 死信 + 预扣搁浅 +
  平台吃全差。修复：InsufficientBalance/Cash 降级为收满预留（consume=Σ预留），日志留痕
  （有界损失、不冻用户资金、不死信）。
- **D4 上游重试双花**：Idempotency-Key=requestId 已由适配器注入（核验确认，补 E2E 断言）。
- **D5 余额不足整单拒绝**：无 balanceFloor 声明的模型足额 fail-closed（402 零上游调用，
  核验确认 + E2E 钉死）。

### 认证与边界安全

- **/oauth/token 整链断裂**（签发 app_id 用 apps.appId 随机串且缺 iss/aud，验证按数字主键
  +iss/aud → 签出的令牌 100% 失败）：改签 apps.id + 显式 iss/aud + ipGuard 爆破锁 + E2E 闭环测试。
- **IP 桶塌缩 DoS**：gateway/client-api 提取来源 IP 时 socketAddress 置 null → 全部请求落进
  进程级常量桶——30 次错 key 锁死整站、5 次注册锁死全站注册。修复：注入真实 socket 地址
  （socketAddressFromContext；app.request 测试形态合法回落 null）。
- **静态 Key 不查属主状态**：封禁用户存量 Key 照常过鉴权 → findActiveKeyByKeyHash join
  users.status=0。
- **chunked 请求体绕过上限**：三面（gateway/client/admin）只查 content-length 头 → 全部改
  hono bodyLimit（按实际流过字节计数，未认证 /oauth/token 巨包 OOM 面封死）。
- **client-api 固定窗口计数器 fail-open**：Redis 故障返回 0 → 兑换爆破/注册农场在抖动窗口
  裸奔 → 改 fail-closed（调用方既有 503 路径终于可达）。

### 资金流程正确性

- **generation 免费交付**：poll 先 CAS 终态后发信号，信号瞬时失败被吞 → 用户拿产物零扣费
  （且不可重试）。修复：先信号后终态 + billing 状态预检（已 settlement_pending/settled 跳过
  信号直接终态化 = 崩溃窗口自愈）；失败保留任务行下轮重试。
- **recover 队头阻塞**：批量单事务释放，一行毒数据（预扣明细断裂）永久阻塞整批滞留单资金
  归还。修复：listExpiredForRecovery 无锁列候选 → 逐单事务 CAS+归还，毒行隔离重试。
- **充值订单搁浅**：全局关单（任意用户列表请求关掉他人支付中的单）+ 过期后合法回调被永久
  拒绝 = 用户已付平台未入账。修复：关单按用户域 + reviveExpiredAsPaid（CAS 4→1，验签且金额
  一致才复活；金额不符不复活）。
- **结算退避过短**：秒级退避 ×8 次 ≈ 2 分钟 → 一次 PG 抖动整批死信冻资。默认改 15s 起、
  600s 封顶、10 次（≈85 分钟耐受）。
- **佣金缺勤永久丢失 + 封禁邀请人照发**：窗口回补最近 7 个 UTC 日（wallet 自然键幂等零副作用）
  + inviterActive 过滤 + 异常留痕。
- **worker 停机/池**：在途批次 Promise 集合全量追踪（原单变量被四循环互相覆盖）+
  abandonOwnedClaims 归还认领 + pool = batch+5（原 5 连接跑 20 并发结算会饿死续租）。
- **唤醒积压吞吐**：BullMQ 固定 jobId 在批次运行期吞掉新唤醒 → 消费端排空循环
  （pendingCount 驱动，一次唤醒连续消费到非满批）。

### 中低危（同日修复）

请求日志不采信 x-real-ip / SSE 响应不 clone 嗅探 / TPM 预占在 model_not_found 与免费日限
拒绝路径归还 / 429 与渠道错误消息不再泄漏内部 ID / multipart 文件上限与全局 bodyLimit 对齐 /
org 成员限额金额结构性校验 / playground 上游错误白名单信封转发 / 充值下单 per-user 频率闸 /
充值面额 ≤2 位小数（Stripe 分截断永久对不上）/ epayVerify 恒时比较 / Key 过期时间须未来 /
公开价格目录不回 realModel / 管理端调账赠送审计与业务同事务 + recordAudit 失败留痕 /
webhook secret 列表掩码 / 管理面导入数组上限（绑定 500/目录 200）/ login-challenge deliverIp
按收件邮箱键控 / 生成任务轮询游标翻页（首屏饥饿）/ 每用户在途生成任务上限（默认 10）/
video 计量描述符 unitsOf 尊重 pricingUnit / already_settled 指标不再混入 claim_lost。

### 新增测试（生产前资金安全网）

- `gateway e2e-cost-drain.test.ts`（7 例，e2e 配置）：D1–D5 全向量闭环——钳制转发体、
  取消/缺 usage 估算收费、累计 usage 精确收费、402 整单拒绝、超额收满预留不死信、
  Idempotency-Key 注入。
- `gateway oauth-appjwt.test.ts`（3 例）：/oauth/token → app_jwt → /v1/models 闭环。
- `service settlement.test.ts` +1：毒行隔离（B 的资金不因 A 的毒行冻结）。
- `service generation-poll.test.ts` +2：信号失败不终态化（不再免费交付）、崩溃窗口自愈。
- `client-api payments.test.ts` +3：过期单复活入账、金额不符不复活、>2 位小数拒绝。

### 扣款逻辑文档化（2026-08-19 补）

- 新增 `docs/billing-flow-deep-dive.md`——v2 扣款全流程唯一真相文档：预扣四道保守
  公式 / outputCap 与转发钳制 / balanceFloor 两模式 / 资金规划 take·放行门 / 实扣公式与
  consume·over 分配 / #over 补充授权与收满预留降级 / 估算收据三归属 / 状态机 8 态 /
  刷费用五向量防线表 / v1↔v2 差异表 / 文件索引。
- v1 视角的旧 `billing-flow-deep-dive.md`（取消估算用 bytesRelayed×tokensPerByte，
  与现扫描器累计内容×校准估算器口径不同）已随 v1 退役整体删除；
  `gateway-pipeline.md`、`architecture.md`、`data-model.md` 带历史横幅并链到唯一真相文档。
- README 文档表补 v2 扣款文档入口。

### 已知未修（记录在案，非阻断上线）

- admin 无 RBAC（所有管理员等价超管）——产品设计决策，建议尽快排期角色/双人来管控。
- 凭证文件存本地磁盘 ./data/vouchers——多副本部署需先迁共享存储。
- /v1/pricing 公开无缓存（低危：读多写少，可在 nginx 层加）。

> 2026-08-20 三项加固完成并从上表移除：
> ① **jti 吊销表**（Bearer 会话即时下线）：identity 新增 SessionRevocationStore（Redis
>   SETEX 至令牌自然过期，免 GC；故障 fail-open+告警——主防线 DB 属主校验仍 fail-closed）；
>   client/admin 双面 middleware 验签后查表；新增 POST /v1/auth/logout（吊销当前 jti），
>   两端 FE 登出先吊销再清 cookie；测试钉死「logout → 同 token 立即 401」。
> ② **global RPM 维**：admitKey 并罚加 global 维（config GLOBAL_RPM 默认 2000，生产
>   硬顶 5000——v1 对位），至此并罚维度 = 凭证+用户+global(+渠道+模型 TPM)。
> ③ **webhook secret 落库加密**：admin 写入侧 encrypt（enc:v1，与渠道 apiKeyEnc 同口径），
>   create/list/patch 响应一律掩码（密文也不回显）；worker 派发侧按前缀解密（存量明文
>   懒兼容，解密失败 fail-closed 该渠道不可投递）；迁移脚本
>   scripts/encrypt-notification-secrets.ts（幂等，dry-run 默认）。

---

## §9 v2 全面审计与加固（2026-08-19/20，25 项清单 + 施工记录）

**审计原则（用户拍板）**：Redis 是首选组件而非可选增强；默认没在用的路径
一律当 bug；越底层越不要默认值；全局配置必须可直接排查。

### P1–P15 Redis 定位错误（可选+静默降级 → 首选+fail-closed）
- P1 网关 RPM/TPM 限流无 Redis 整条跳过；P2 免费模型日限（免费链路唯一
  防线）无 Redis 时不存在；P3 Key 爆破防护跳过；P4 熔断/死凭据状态进程
  内存（多副本各自为战）；P5 BullMQ 唤醒未移植（v1 有，v2 轮询为主——倒退）；
  P6 worker AI 状态同内存；P7 轮询间隔无配套设计；P8/P9 用户面登录注册兑换
  限流爆破全关；P10 OAuth state 内存 Map（多副本+重启坏）；P11/P12 admin
  登录防护关+缓存广播失效；P13 全部降级静默无告警；P14 fail-open 写死无开关；
  P15 .env 配了 Redis 但代码按可选设计。
**决策语义**：REDIS_URL 四 app 必填、缺失/连不上启动即失败；运行时 Redis
故障 → 防护路径明确报错（网关推理 503/登录注册 503/admin 写失败），
唯一例外 worker 唤醒通道（error 日志+healthz degraded，结算继续走兜底
轮询——账务时效优先）；/healthz 加 Redis readiness。

### P16–P25 部署面与默认值死角
- P16 生产 compose 全 v1 镜像（nginx→gateway:8787），v2 无部署服务；
- P17 .env 是 v1 键位（DEFAULT_USER_RPM/TPM、WORKER_CONCURRENCY 等 v2 不读）；
- P18 OAUTH_API_BASE=8791（v1 死端口）vs FE 按钮 CLIENT_API_BASE=8081——
  OAuth 回调链路断（redirect_uri 指向无人监听端口）；
- P19 OTEL_TRACES_MODE=otlp 指向 :8793 黑洞（与 v2 保持 off 的决策冲突）；
- P20 playground 导航死链（UI 入口在，/api/playground/chat/completions 路由不存在）；
- P21 邀请返利文案承诺奖励但 REFERRAL_* 默认零（承诺与配置不一致）；
- P22 .env 无任何支付渠道（充值空态）；P23 ALLOW_LOCAL_UPSTREAM 键名三 App
  分裂（admin 读旧键、gateway/worker 读新键——同一部署行为不一致）；
- P24 settlement.renewClaims 实现未接线；P25 15 处裸 catch{}（复查项）。

### 施工波次（2026-08-20 全部完成，全仓门禁 32/32 绿）
- **Wave A 配置层**：四 app `REDIS_URL`/`DATABASE_URL` 必填（zod 无默认）；
  启动 `assertRedisReachable`（重试至截止，冷连接友好；失败拒绝启动，
  错误带脱敏 URL）；每 app 启动打**配置快照日志**（关键业务参数生效值
  一处可查——「以为配了其实默认」类问题直接排查）；.env 全面换 v2 键位
  （**P18 修复：OAUTH_API_BASE 8791→8081**；OTEL→off；ALLOW_LOCAL_UPSTREAM
  拆三键；删 v1 死键；REFERRAL 参数落值 1 元/10%；CLIENT_API_BASE/
  ADMIN_API_BASE 显式）；FE `CLIENT_API_BASE` 去默认值（api-client
  requireBase 漏配即明确报错）+ apps/{client,admin}/.env.local；
  四 app vitest 配置统一载入根 .env（测试不再手工 source）。
- **Wave B 运行时 fail-closed**：core 限流器/爆破防护默认 fail-closed
  （`RateLimitUnavailableError`/`AuthGuardUnavailableError`→503，可显式
  failMode:'open'）；gateway error-map 加 503 映射；登录/注册/兑换计数器
  失败→503；OAuth state **内存实现删除**（Redis 唯一，save/consume 失败
  fail-closed）；admin 缓存广播随 Redis 常在；healthz 加 Redis readiness
  （client/admin 503 摘除）；**renewClaims 接线**（run-once 批间每
  claimLeaseMs/3 续租，P24 关闭）。
- **Wave C BullMQ 唤醒**（P5 关闭）：service `BillingEnv.wake` 端口
  （signal→settlement_pending 后事务外调用）；gateway `billing/wakeup.ts`
  生产端（固定 jobId 去重，**removeOnComplete:true——保留已完成任务会让
  固定 jobId 投递被静默去重丢唤醒**，集成测试抓到的真 bug）；worker
  `wakeup.ts` 消费端（concurrency 1 + 合并执行器，突发唤醒折叠成批次）；
  `SETTLE_WAKE_QUEUE` 常量下沉 service（生产/消费共同契约）；
  WORKER_SETTLE_INTERVAL_MS 1s→30s（唤醒为主、扫描兜底）；集成测试：
  合并语义 + signal→队列→唤醒→结算全链（无定时器参与）。
- **Wave D playground 移植**（P20 关闭，最后一个功能件）：gateway
  api-key 中间件加 **JWT 凭证分支**（typ app_jwt 查 apps 有效行 / typ
  playground 载荷限额；顺带修复 /oauth/token 发的 JWT 无人能接的死角）；
  AuthContext 加 appId、apiKeyId 可空；限流维度 key:{id}/user:{userId}；
  client-api `POST /v1/playground/chat/completions`（会话守护 → 现签
  5 分钟 typ playground JWT 独立低限额 RPM10/TPM20万 → 代理网关 SSE
  原样回传，请求体 zod 白名单收敛）；PLAYGROUND_* 成组配置；FE
  `/api/playground/chat/completions` route handler（HttpOnly cookie 换
  Bearer + SSE 流式）；测试 6 例（含上游错误直传/封禁 403/字段收敛）。
- **Wave E 部署**：compose.yml 增 v2 四服务（gateway:8083/client-api/
  admin-api/worker，与 v1 并存；**nginx 切流节奏待用户确认**——
  当前生产入口仍指 v1）；.env.example 同步 v2 键位。
- **验证**：全仓 regress 32/32（client 151/gateway 97/admin 151/worker 14
  + 共享包）；Redis 故障注入实测（brew stop redis → 四 app 启动拒绝
  「Redis 启动验证失败…拒绝以降级形态启动」且不监听端口；恢复后正常；
  配置快照日志正常输出）；P25 复查：15 处裸 catch 抽查均为正当语义。
- **Task 3 默认值深挖结论**：基础设施类（DATABASE_URL/REDIS_URL/
  CLIENT_API_BASE/ADMIN_API_BASE）全部去默认值——漏配即启动/调用时报
  明确错误；业务参数（面额闸/赠送/返利/免费日限/防护阈值）保留默认但
  全部进启动配置快照（生效值一处可查）；安全方向默认保持 fail-closed
  （SECURE_COOKIE 显式 false 于 .env，生产应 true——运维责任已注明）。
- **浏览器全链复验（2026-08-20）+ P26 新 bug 修复**：登录（含 fail-closed
  防护正常路径）→ 邀请页新配置生效（10% 佣金/「双方各得 ¥1」文案）→
  邀请链接注册 → 双方各 +1 元入账（wallet_transactions 双腿验证）→
  名单+1 → 操练场页面渲染（模型下拉/输入/发送）✓。**P26**：v2 /v1/me
  返回 accounts 数组而 FE MeInfo 期望顶层 balance——client dashboard
  余额恒显 0（迁移遗漏，此前无非零余额用户所以从未暴露）；修复 =
  api-client getMe 形状归一（accounts[0] → balance/status）。另：FE
  standalone 运行时需 CLIENT_API_BASE 环境变量（构建不内联非 NEXT_PUBLIC
  变量——compose console 服务已按此约定注入）；api-client 补 ./session
  子路径导出。

- 已建成：domain（79 单测）/ service（49 集成测试：billing 瀑布 12 + settlement 9 + wallet 15 +
  funding 13）/ repository / gateway 消费方形态。0060 迁移（billing_reservations + 开关列）已入 dev 库。
- 待办（做完划掉并更新此节）：
  - ~~资金域收尾：积压准入工厂、wallet refund 动词、文件原子化~~（2026-08-19 完成：
    domain 90 测试 + service 91 测试全绿；wallet 九动词、channel-budget 一动词一文件、
    billing/admission.ts 工厂、domain rating 拆 calculate/receipt/amounts；测试补齐攻击面/
    幂等竞态/限额闸/失败退避/渠道收尾六套件，并修复 settlement 装配漏配 channelBudget 的真 bug）；
  - app 层（业务全在 service 包，app 只做协议/编排/装配）：
    - gateway G1 已完成（2026-08-19）：hono 骨架 + 装配根（config zod 全显式）+
      错误信封翻译表（domain 家谱→HTTP 契约）+ API Key 鉴权中间件（SHA-256 查表 +
      吊销/过期守卫）+ /healthz（repo health.ping）——15 测试全绿；
    - gateway G2 已完成：报价构建——repo 新增 model-mapping.repo（候选链批量解析）+
      user.findRateCardId；app 侧 quote/build-quote.ts（链序/fallback 跳过/系数按映射分档/
      停用卡拒/全链免费才 explicitlyFree）+ AppError 协议错误——20 测试全绿；
    - gateway G3 已完成：模型路由——repo channel.findRouteCandidates（model_channels
      绑定表 join，仅 status=0，priority/weight 基序）+ app routing/（schedule 分层加权
      随机纯规则·rng 可注入 / switchable 换渠判定词表 / resolve-channels 编排）——27 测试全绿；
    - gateway G4a 已完成：推理管线编排——pipeline/（output-cap 输出上界纯规则 /
      upstream-port 上游接缝 / receipt 收据装配含缺 usage 估算政策 / run-chat 编排核心：
      报价→预扣→渠道调度→逐渠预留→换渠→收据 signal→全败三路归还）+ POST /v1/chat/completions
      路由——31 测试全绿（成功/换渠敞口原子归还/全败 released 归零/余额不足 402 零落）；
    - gateway G4b 已完成：生产上游适配器（createAi 七协议 + apiKeyEnc core.decrypt
      解密 + ai Usage.estimated→缺 usage 语义）+ 跨模型 fallback 双层循环（候选模型 × 渠道，
      收据用实际成功候选快照——externalModel 一律请求名锚点，老网关语义）+ 死凭据落库
      （repo markDeadCredential：status 0/3→4 + 事件箱同事务）+ 进程内存 ai 状态存储 +
      生产装配（assembly 挂 runChat，index 启动即带路由）——33 测试全绿；
    - gateway G4c 已完成：SSE 流式中继——端口 chatStream（事件含终态重放契约）+
      适配器透传 + runChat 统一双分支（first_chunk 前同语义换渠 / 上线后事件锚定收尾；
      终态收据三形态：可信 usage 正常 / 用户侧取消估算 estimatedFor=client_disconnect +
      bytesRelayed / 完成缺 usage 估算 usage_missing_completed）——36 测试全绿；
    - gateway G4d（运营加固，依赖部署设施）：Redis 熔断/死凭据/路由缓存多副本共享、
      鉴权爆破防护、App JWT（jose）、OTel 链路；
    - worker 已完成（2026-08-19）：config（节奏/批次/策略全显式）+ run-once 批次编排
      （认领→并发 processClaim→计数回执）+ index 双定时器（结算轮询 + 滞留回收）+ 优雅停机
      ——3 集成测试全绿（批次闭环实扣/幂等/回收释放）；BullMQ 唤醒待接 Redis（轮询已是
      正确性兜底）；
    - gateway 接口面补齐（G4c+，2026-08-19）：GET /v1/models(/:model) 模型目录（repo
      listEnabledModels）+ 安全中间件三件套（CORS 预检白名单/安全头/body 413 上限）+
      /v1/* requestLog（鉴权前挂载，401 也入日志；repo insertRequestLog）+ notFound 404
      信封 + 鉴权按已注册端点挂载（未知路径 404 而非 401，老网关语义）——42 测试全绿；
    - gateway G5a 已完成：文本族全端点 + 原生协议——端点注册表驱动挂载
      （inference-endpoints.ts：chat/completions/embeddings + completions/responses/messages
      三 codec）；embeddings 输出恒 0 口径（output-cap kind 分档）；模态 JSON 族
      （images/rerank/moderations/audio-speech）走同一管线单位计费；旧单路由退役
      ——50 测试全绿（含真实 codec 双向翻译 8 例）；
    - gateway G5b 已完成：模态 multipart 族 + /oauth/token + 计费配置系统——
      pricing-strategy（flat/variant 策略注册表，新公式=加一行；estimate 保守/settle 精确；
      变体选择器支持多参数组合键 "size:quality"）+ measurement（计量描述符注册表，
      token/image/second/char/request 五维度）+ DB 0061 billing_config JSONB 列
      （模型声明策略与变体价格表，与 pricingUnit 正交）——build-quote 消费两轴解析单价
      ——domain 103 + gateway 52 测试全绿；~~v1beta 原生协议~~（用户拍板不要，已删）；
    - 计费两轴接线修复（2026-08-19，G5b 收尾）：G5b 只建了注册表没接线——
      ① 收据从不装配 usage.units → 单位计费模型结算恒 0 元（漏收全款）；
      ② 预扣上界绕过注册表在 run-chat 本地硬编码 → 音频按秒恒押 1 秒（audioSeconds
      无人消费）。修复：报价候选携带 pricingUnit + 注册表推 unitUpperBound（逐候选，
      build-quote 单一消费点）；收据装配经 unitsOf 取结算实值（响应实值优先/参数兜底）；
      second 描述符补 audioSeconds 口径（音频秒确定性=结算值，video duration 钳制）；
      image 结算对齐 v1 语义（data.length 兜底 n 最少 1）；char 改码点口径；
      kindOf 按排除法分类（multipart 三 kind 此前漏判成 chat）；multipart 路由
      错误契约修正（仅解析错误 400，管线错误走统一翻译——402 不再吞成 400）。
      回归测试：音频按秒预扣 45.5=91s×0.5 / 图片变体+按张经真结算实扣 98.4=100-2×0.8
      ——domain 104 + gateway 54 测试全绿；
      注：v1 侧 gateway/admin-api/client-api 测试套件在 HEAD 即失败（it.skip 写在
      it() 内的收集错误 + 并行 DB 干扰），与 v2 无关，待 v1 清理时一并处置；
    - 预扣策略注册表（2026-08-19，层 3）：「押多少、何时放行」与定价策略同构可配——
      billing_config.reservation = { strategy, params }（DB JSONB，通用形状、数据驱动、
      每模型独立）；domain rating/reservation-strategy.ts：RESERVATION_STRATEGIES 注册表
      （full 缺省=现行全额保守 fail-closed / floor 首个策略 params{units,balance}，
      非法参数与未知策略名结构拒绝）。两规则各一个消费点：unitFloor → build-quote
      作用于计量上界只抬不降（视频「至少 5 秒的钱」/图片「至少 1 张的钱」）；
      balanceFloor → planFunding 放行门（实筹 ≥ 阈值即放行、hold 封顶实筹，
      文本模型「余额 0.1 就能跑」；透支缺口由结算 §4 补充授权兜底），
      authorize 取候选链最严阈值。新预扣逻辑（按比例/分档/时段）= 加一个策略对象。
      回归测试：余额 0.15≥0.1 放行 hold=0.15 / 0.05<0.1 → 402 / duration=4 保底 5s
      hold=2.5 且结算实值仍 4s / 未声明 402 语义零变更
      ——domain 110 + gateway 58 测试全绿；
    - gateway G4d 已完成（2026-08-19，生产加固）：内存实现全部替换为可选 Redis
      生产形态——core 新增 redis/ 基建模块（script-runner evalsha+NOSCRIPT 自愈 /
      ai 状态 CAS 存储（熔断+死凭据多副本共享，fail-open）/ 滑动窗口限流器
      （RPM ZSET + TPM actual+reserved 预占/释放/续租，付费链路 fail-open）/
      两层鉴权爆破防护（per-keyHash 失败计数锁 + per-IP 无差别刷锁定，fail-open），
      全部 v1 语义忠实移植；REDIS_URL 未配置 = 单副本开发形态（状态内存化、
      限流/防护跳过）。gateway：key 维 RPM/TPM 准入（api_keys 列）+ 渠道维
      尝试前判定（超限换渠）+ TPM 失败归还 + 免费模型日限（唯一防线 fail-closed，
      超限 429/计数器不可用 503 两口径）；上游调用 deadlineMs；OTel 中间件
      （off=no-op）+ /readyz；优雅停机（停收新请求→宽限 drain→OTel flush→
      连接收口，宽限耗尽强退）。worker：Redis ai 状态 + 优雅停机（等在途
      批次→关连接）。测试：gateway 71（+7 加固）+ core 12+5skip（真实 Redis
      才跑）。遗留（低优先）：TPM actual 结算回填（当前 reserved 由 600s TTL
      自回收，分钟内保守正确）；BullMQ 唤醒（轮询已是正确性兜底）；
      client-api、admin-api 待建；
    - 测试完备化（2026-08-19，生产水准收口）：五类缺口全部补齐——
      ① worker 装配层（config fail-closed/适配器 ai 注入+解密透传/三定时器真实
      批次闭环/stop 关连接拒绝后续查询）；② gateway 停机抽 createShutdown 可测
      （drain 顺序 exit0/宽限强退 exit1/二次信号幂等）；③ ai task-adapter 单测
      （stub Ai 六分支）+ gateway upstream-adapter 绑定单测（解密/deadlineMs/
      usage estimated 丢弃/baseUrlOverride 优先）；④ 本地 mock HTTP 上游的真
      适配器冒烟（openai-compatible：非流式 usage 归一入收据/SSE 透传+尾帧可信
      usage/错密钥 401→换渠耗尽 502 三路归还）——**冒烟抓到真生产 bug：真 ai
      事件是读取驱动且只重放终态，惰性订阅会漏 first_chunk → 流式换渠判定死锁；
      修复=适配器立即订阅+全量缓冲重放+pumpThrough 泵式透传（不依赖下游读取）**；
      ⑤ 免费日限 Redis 语义（忠实 eval 假件：超限/用户隔离/计数器故障 fail-closed）
      + oauth 三凭证传递分支 + submit 落库失败 503 预留保留/死凭据渠道落 status=4
      + switchable 词表 + output-cap 优先级。gateway 集成套件 fileParallelism=false
      （共享单 PG 确定性优先）+ 用户维度兜底清账。终态：gateway 90 例 90.4% stmts
      / worker 7 例 / ai 299 / core 12+5skip(Redis) / domain 114 / service 97；
      client-api、admin-api 待建；
    - 安全/资损专项（2026-08-19 审计后修复）：① **S1 复发堵死**——v2 的 requestId
      曾采信客户端 X-Request-Id（v1 已修的 S1 漏洞复发：固定 ID → 限流 ZSET
      member 去重 → RPM/TPM 全绕过 + uuid 列 500）；修复=服务端生成+响应回显，
      客户端头仅日志关联，request-log 同步改用服务端 ID；回归：固定头连发 →
      账单独立两行+回显 ID 各异、非 UUID 头正常处理。② 上游错误脱敏
      （sanitizeUpstreamDetail：内部 URL/host 剥除 + 真实模型名→对外名 + 截断）
      接入 run-chat/submit 两处 502——端到端断言响应不含 real-*/内部域名。
      ③ 任务双副本并发双结算回归（两 poller 并发同任务 → CAS 单赢家、
      settlement 只扣一次 97=100-3）。④ 流式终态 double-fire 重入回归
      （success 事件重复投递 → 同 requestId 恒一行单据态）。终态：gateway 95 例
      / service 98（generation-poll 7）；client-api、admin-api 待建；
    - E2E 真链路（2026-08-19，独立通道 `pnpm --filter gateway test:e2e`——
      默认门禁不依赖外网）：真网关进程（hono serve + 全真装配）+ 平台 ag_ key
      + dev 库 RX-M3→MiniMax-M3 真上游。四场景实测：① 流式中途取消（已有输出）
      → 单笔账单、结算后余额 ≥ -0.05、在途归零；② 上游未返回时取消 → 账单
      有始有终（settle/release 皆合法态）、在途归零；③ 低余额 0.006 并发 8 路
      → **放行 4 / 402 拒绝 4**（fail-closed 生效），Σ实扣 0.0017 与余额分毫
      对账，亏损深度 ≤ 单笔级 §4 超额（未观察到负值）；④ 5 用户 × 4 并发
      （实测 18×200 + 2×502 上游瞬时拒绝）→ 每用户账单数 == 自己成功数、
      usage_logs 归属精确、钱包分毫对账（1 − Σ实扣）、在途全归零、无跨用户
      串账。附带产出：DB_POOL_MAX 配置化（高并发下 10 连接不够，E2E 用 40）；
      共享 dev 渠道预算先快照后还原。运行口径：外网 + dev 库 + 真上游，
      turbo 默认门禁不含（排除 e2e-*.test.ts）；
    - E2E 对抗套件（2026-08-19，e2e-attack + e2e-kit 共享基建，累计 11 例）：
      ⑤ 非法请求全家族（坏 key 401/缺 messages 400/未知模型 404/负 max_tokens 400/
      SQL 注入模型名 404/超 10MiB 体 413）全部零扣费零账单；⑥ 伪造 x-request-id
      连发 → 服务端 ID 独立两笔（幂等键不可碰撞）；⑦ 非流式断连 → 单笔照实计费
      （断连≠免费）；⑧ 取消风暴 6 路并发流交错取消 → 恰 6 笔、分毫对账、在途归零；
      ⑨ stream/非 stream 混合 4+4 → 收据旗标不串、**收据 token 与 usage_logs
      逐笔相等**；⑩ n 倍数两分支（成功计费/上游拒绝释放不扣）。**又抓一真缺口：
      chat/completions schema 未校验 max_tokens——负值直通上游 200 放行**（已修：
      int positive ≤1M，n≤16 同步补）。无法本地确定性复现的向量显式归档到集成/
      单测层（覆盖矩阵在 e2e-attack.test.ts 文件尾）：Redis 两层爆破防护、免费
      模型日限、§4 超额推负、上游故障注入换渠、任务双副本双结算、流式 double-fire。
      终态：E2E 11 例 + 集成 99 + 单测全绿；client-api、admin-api 待建；
    - E2E ⑪认证绕过 + ⑫全库审计（2026-08-19，e2e-auth-audit，E2E 累计 15 例）：
      ⑪ 全部推理/任务/目录/查询端点无凭证与坏凭证五形态（Basic/裸串/JWT 样/空
      Bearer/错位 key）一律 401——不存在绕过认证直调模型的路径；上游真实密钥
      零泄露（明文与密文在响应体/request_logs/usage_logs/账单 JSON 全扫描零命中）。
      ⑫ 全库七表逐字段审计（2 非流+1 流结算后）：billing_requests（quote 候选
      快照含映射 id/双模型名/双价、收据系数/渠道/estimated、租约清理）、
      billing_reservations（份额合计==预扣投影）、usage_logs（token 与收据逐笔
      相等 + **金额公式以收据价格快照复核**——修正审计自身写死缓存价的错误）、
      wallet（余额==充值−Σ实扣、4 腿流水 balance_before/after 链式连续、尾账
      ==账户余额、主授权按 ref_id 配对 amount==预扣/settled==实扣）、request_logs
      （每请求一行 200）、渠道预算 delta==Σ成本。实测：Σ实扣 0.00137088 ==
      流水合计 == 预算 delta 分毫一致。E2E 运行口径不变（test:e2e 独立通道）。
    - E2E ⑬参数异常 + ⑭floor 击穿（2026-08-19，e2e-params-floor，E2E 累计 20 例）：
      ⑬ 预算参数异常全家族（1e9/Infinity/负/非整数 max_tokens、n 越界、空/超量
      messages、embed 批 2049）→ 全 400 零扣费；边界内超大内容（9MiB prompt、
      1e308 采样参数透传）→ 不 5xx 不崩账、资金一致。completions prompt 数量
      上界补齐（v1 哲学：计费参数强校验/数量上界防 JSON 放大/内容长度 10MiB
      body 兜底/采样参数透传上游裁）。⑭ balanceFloor 并发击穿实测：估价>余额
      时并发 8 路 → **放行 1 / 402 拒绝 7**（首路押尽可用额余路必拒）；单路
      大输出负债 ≤ 单笔真实用量；连环放行累积亏损 == Σ真实用量。
      **抓到第 4 个真 bug：floor 封顶单的 reserved_amount 投影记未封顶估价 →
      结算不变量 Σ明细≠投影 → 死信 + 押金冻结**——修复：authorize 落账投影 =
      Σplan 实筹（结构性满足结算不变量）；pipeline 补集成回归（floor 封顶单
      真结算 settled + 押金解冻 + 0.15−0.03 精确实扣）。E2E 累计战果 4 个真
      bug：流式换渠死锁/S1 requestId 信任/max_tokens 直通/floor 投影死信。
    - E2E ⑮慢上游三形态 + 两项修复（2026-08-19，e2e-slow，E2E 累计 22 例）：
      实测「上游慢」的边界——流式无碍（19s 长流透传+照实计费；首字节 60s/
      帧间空闲 120s/心跳 30s 预算宽裕）；非流式慢响应头（>connectMs 10s）
      会被误杀（31s→502，资金安全 released 但功能不可用——MiniMax thinking
      非流式正是此形态，且 61s「上游超时」实为我方重试累计非上游限制）。
      修复①：GATEWAY_UPSTREAM_CONNECT_TIMEOUT_MS 旋钮（默认 10s 保持 v1
      语义，慢上游部署放宽；assembly 注入 createAi timeout.connectMs）——
      E2E 实测 60s 档下 3000 字非流式 27s→200 照实计费。修复②：**长流续租**
      （v1 withBillingLifecycle 语义，v2 重写时丢失）：上线后每 1/3 TTL 续
      lease.renewed、终态即停、100 次上限防协议违约泄漏——修复前 >TTL(300s)
      的长流会被 recover 误释放→终态冲突→**漏收**；pipeline 补短 TTL 慢流
      集成回归（续租期间结算不冲突）。
    - E2E ⑯worker 全链（2026-08-19，e2e-worker，E2E 累计 25 例）：补齐 worker
      「真网关 HTTP → 真 worker 三定时器 → 落库」的全链验证——⑯a 结算环（chat
      请求 → settle 定时器消费 → usage_logs/钱包腿/渠道预算扣减三处由 worker 落账，
      证明数据接收正确）；⑯b 生成环（本地 mock MiniMax 视频上游按协议形状：提交
      →task_id / 查询 Queueing×2→Success+file_id / files/retrieve 换 url →
      网关提交 201 → generation 定时器驱动终态 → 结算实扣 2=5−6s×0.5，产物 url
      落库）；⑯c 停机语义（stop 后 pending 停留不再消费）。配套：SSRF 防护的
      dev 逃生门两枚（GATEWAY/WORKER_AI_ALLOW_LOCAL_URL，默认 false——生产
      恒关，测试连本地 mock 专用）；worker 侧 createAi 支持注入 allowLocalUrl。
    - gateway G6 已完成（2026-08-19）：video/music 异步任务族——接口面与 v1 对齐。
      domain 新增 generation 词表（task_poll/task_execute 执行模型 + 快照白名单，
      新类型=注册一个描述符；计量不重复——单一真相在 measurement 注册表）；
      repository 新增 generation-task.repo（插入/归属查/认领/超时扫描/CAS 终态，
      复用 v1 的 generation_tasks 表——两阶段计费设计完备）+ channel.findTaskChannel
      （在途任务可达，不做 status 过滤）；service 新增 generation 域：TaskPort 纯接口
      （service 零 ai 依赖）+ 轮询用例（超时释放/running 续租/succeeded 收据结算/
      failed 释放/music 代执行——幂等靠任务行 CAS + signal 状态机守卫）；
      gateway 新增 generation/submit 编排（报价→authorize（含预扣策略）→候选×渠道
      →task_poll 提交上游/task_execute 只登记→任务行落库（收据模板+计量快照）→
      租约覆盖 TTL→201；全败 502 三路归还；落库失败 503 预留保留禁误退款）+
      routes/generation（POST /v1/video|music/generations + GET /v1/videos|musics/:id
      归属校验 404）；ai 包新增 createGenerationTaskAdapter（协议单一真相，decrypt 注入、
      结构化对齐 service 端口——gateway/worker 两 app 共用，薄绑定各 10 行）；
      worker 新增第三定时器（generation 轮询）+ config 全显式。回归测试 12 例：
      提交两形态/全败 502/402/非法体/归属查询 404 × 轮询六态（含经 settlement 实扣
      6s×0.5=3 元端到端）——domain 114 + service 97 + gateway 64 + worker 3 全绿；
    - client-api C1 已完成（2026-08-19，用户面闭环）：注册→登录→Key→钱包→兑换→充值
      全链生产可用。架构落点遵守「单 app 域不进共享包」：SQL 全部进 repository
      （新增 user-account/api-key/redeem-code/payment-order 四仓储——建号唯一索引兜底、
      改密+会话失效线单语句原子、核销/吊销/订单跃迁全 CAS），业务在 app services
      （auth/keys/wallet/redeem/payments），资金动词复用 service/wallet（credit 幂等三段式；
      装配白名单 refTypes=[gift,redeem,topup] fail-closed）。会话：identity 包 JWT
      （type=user issuer 物理隔离管理面）+ Bearer（无 Cookie 无 CSRF）+ 每请求回查
      users（封禁即时）+ R5-2 失效线（改密全网下线，auth/app 两套件都有断言）。
      支付：PaymentProviderPort + epay 适配（键序 MD5 签名纯规则在 app domain），
      回调三闸=验签→金额核对（签名合法≠金额合法）→单事务 markPaid→credit→markCredited；
      creditAmount 创建时定死不重算。登录爆破双层（per-邮箱哈希+per-IP，Redis 形态
      fail-open）+ 注册 per-IP 限流；哑哈希防账号枚举。测试 46 例六文件（真 PG）：
      auth 12（含赠送幂等+爆破锁）/ keys 6（明文一次出库+哈希可被网关查表命中+越权 404）/
      redeem 4（并发同码唯一赢家）/ payments 10（重放/并发回调/坏签名/金额篡改零入账）/
      app 7（HTTP 全链+会话安全语义+信封）/ architecture 3（白名单+零 SQL+v1 冻结禁入）。
      v1 对齐件（邮箱验证码/OAuth/人机验证/组织/订阅/playground/Stripe）显式挂待办。
      v1 27 个路由测试对照扫描（2026-08-19）：3 等价 + 8 部分 + 1 设计性不适用（CSRF——
      Bearer 无 Cookie）+ 15 功能未建（org×3/订阅×3/usage×3/OAuth/验证码/轮换/兑换历史/
      Apps/兑换频率限流）；扫描抓获并修复 1 个真 bug：dailySpendLimit=1e21 科学计数法
      绕过裸 Decimal refine → numeric 溢出 500（v1 keys.numeric-limit 同类）——结构性
      拒绝下沉 domain/key-limits + topup（parsePositiveAmount + 1e12 业务上界），48 例全绿。
    - client-api C1.5+C2 已完成（2026-08-19，「都补」五轮——v1 27 测试文件 27/27 语义等价）：
      C1.5 小件：兑换频率闸（per-user 10/min 429）+ usage 三端点（明细 billedBy 拆分+
      keyName/appName 来源 / by-model 聚合 / 实时速率——usage_logs 用户隔离硬条件）+
      Key PATCH（网关每请求查库，v1「PATCH 清缓存」结构性不存在）+ 兑换历史 +
      displayName 自助改 + XFF 专测（hops=0 不信 XFF / =1 右数第 1 跳）。
      C2a 订阅域（多 app 共享 → service/subscription）：domain 新增 subscription 域
      （rules 纯函数：顺延/线性折旧/只升不降/席位能力 + 单类携 code 错误家谱，禁引表
      进架构测试）；service 新增 purchase/renew/change（operations 幂等 + wallet.transfer
      现金收款禁透支 + one_active_uq 并发兜底→already_subscribed + C4 惰性翻转 +
      续费凭证改绑复用 credential.rebindCredentials）；app：/v1/plans 公开目录 +
      POST /v1/subscriptions ×:id/change ×:id/renew（idempotency-key 语义同 v1）+ 我的订阅。
      15 例：现金扣款/幂等重放零双扣/加油包·零价·停用三拒/企业席位闸/团队建组织/
      续费顺延+改绑/升档折算 25=30−10×50%/免费升级零收款/降档拒/C4。
      C2b 组织：org.repo（席位计数/邀请 CAS 翻转/成员复活 upsert/订阅归属守卫读模型）+
      org.service（pending 上限 min(max(剩余,1)×2,20)/接受=事务内锁订阅行+复检席位+
      原子翻转（TOCTOU 回滚）/owner 403/邮件匹配）+ Key/Apps 凭证绑组织订阅（W1）。
      12 例 + Apps 3 例。
      C2c 邮箱验证码+人机验证：identity 包挑战表（密码哈希存挑战不落明文）；register
      两步（code_required→verify 建号）/login 密码对不签会话先发码；SMTP 缺失而模式
      强制 503 fail-closed；60s 冷却 429；验码一次性；captcha 三态（缺 400/错 400/
      厂商不可达 503 fail-closed）+ /v1/auth/capabilities 能力端点。9 例。
      C2d OAuth（GitHub/Google）：fetch/端点可注入；state 双提交 cookie + Redis 单次
      （GETDEL）；token 经 URL fragment 回传前端（不进服务端日志）；issuer 物理隔离
      不合并本地同邮箱账号；封禁 403 不被 502 兜底吞掉。10 例。
      收尾：Key 轮换（新 Key 继承设置+同事务吊销旧 Key；订阅过期→降级个人余额=L1）+
      Apps 凭证管理（client_secret 仅一次下发/禁用 CAS/轮换；W1 同口径）。5 例。
      wallet 装配白名单扩为 [gift,redeem,topup,subscription]×[outside,platform_revenue]。
      未移植（v1 也无测试）：playground
      （org 成员子配额授权侧执行后经复核确认已在 service 资金域接线——
      SubscriptionSource.probe 消费 memberLimits，非缺口；Stripe 渠道与
      referrals 邀请返利 2026-08-19 已移植，见基线待办）。app 累计 108 例 12 文件全绿。
    - client-api E2E 通道（2026-08-19，22 例 4 文件，test:e2e）：e2e-kit 起真服务进程
      （全真装配 + epay 测试商户凭证注入）；④跨 app 复用 gateway e2e-kit（相对路径
      import）双真服务同库拓扑——HTTP 注册→epay 回调充值→HTTP 开 Key→真网关 RX-M3 小
      请求→settleAll 结算→assertReconciled（余额==20−Σ实扣、在途 0）→client-api 用量/
      按模型/钱包三面读数与网关对账同一数字→吊销 Key 网关即 401。②组织全链含席位闸/
      邮箱不匹配 403/成员视角隔离/W1 绑定与移除后降闸。③OAuth 本地 mock GitHub（node:http）
      + 端点覆盖 env（OAUTH_*_ENDPOINTS_JSON）走真 302/cookie/fragment-token 流；为此
      oauth state 存储补内存单次实现（无 Redis 的单副本形态不再丢 next/单次语义——
      E2E 抓到的真缺口）。配套：默认 vitest 排除 e2e-*，独立 vitest.config.e2e.ts。
    - 兼容垫片清除（2026-08-19）：加密「双 key 轮换窗」整族删除——core/crypto 的
      version/oldKey 参数（单 key 单格式 enc:v1，盘上格式不变故 2400 条存量渠道密文
      不受影响）、gateway/worker 的 CHANNEL_API_KEY_ENCRYPTION_OLD 配置与
      upstream/task/generation 三适配器穿线、ai task-adapter、http encryptCurrent 的
      世代选择。v1 admin-api/gateway 的调用点在冻结层（运行时多传参无害）；其
      typecheck 报错按既定规则忽略。core 加密测试重写为单 key 语义（5 例）。
    - dev 启动面收口（2026-08-19）：turbo.json 补 concurrency:"20"（持久任务数 ≥
      默认并发时 turbo 拒启）；根 `pnpm dev` 限定 v2 三件套（gateway/worker/client-api
      ——老应用不再随全量 dev 拉起，代码与单独脚本 dev:client-api 等原样保留，
      dev:all 可全量）。真启动验证：三进程起、8080/8081 healthz 200。
    - 启动路径修复两件（2026-08-19，dev 实跑暴露）：①config 键名脱节——gateway/worker
      要求 CHANNEL_API_KEY_ENCRYPTION 而 .env 规范键是 ENCRYPTION_KEY（E2E 显式传参
      所以从未暴露）→ loadConfig 回落 `CHANNEL_API_KEY_ENCRYPTION ?? ENCRYPTION_KEY`
      （专用名优先，两处都缺仍 fail-closed）；②Redis 不可达刷「Unhandled error event」
      → core 新增 createRedisClient 工厂（错误监听必挂 + 30s 去重日志 + URL 认证
      脱敏 + 降级语义提示），三 app 装配统一接入；真启动验证：Redis 挂死时单条清晰
      日志、服务照常、healthz 200、优雅停机。core 14+5skip。
    - admin-api 切片一·计费三轴（2026-08-19，71 例 9 文件）：四层重写 v1 管理面
      配置族——SQL 全部下沉 repository（新 admin-account/provider/rate-card 三仓储 +
      channel/model-mapping 扩管理 CRUD：插入/部分更新/软退役/统一列表 join 计数/
      绑定全量替换/探针连接信息/页内聚合下推；列表 ilike 转义助手包内 search.ts）。
      app 层（apps/admin-api）：Bearer 管理会话（identity type=admin issuer 物理隔离，
      跨面 token 互斥 + R5-2 失效线 + 封禁即时下线，无 Cookie 无 CSRF）+ auth 服务
      （密码登录哑哈希防枚举 / 2FA 邮箱验证码两步：4×401 后挑战作废、60s 冷却 429、
      SMTP 缺席 503 fail-closed / 改密原子推进失效线 + 同拍新 token / 2FA 开关
      未配 SMTP 400）；providers（协议词表单一真相 = ai SUPPORTED_PROTOCOLS，非法 400
      不触库；重名靠 23505→409 cause 链翻译）；channels（apiKey 落库即 enc:v1 密文、
      响应/列表永不回密文明文；换 Key 复位运行态 status4→0/failCount 清零；批量导入
      best-effort 供应商缺失条目失败不中断全败 400；探针解密真发生回显仅 keyPreview；
      models 白名单契约 string[]）；models（R6 免费价格一致性：创建直判 + 更新合并判
      部分补丁不能造矛盾态；绑定全量替换空数组=解绑；channelIds 回显未绑定=[]；
      数值域铁三角 '1e999'/1e21/ctx 1e30 全 400 不触库；探针 chat=1 条"1"+max_tokens 1
      + maxRetries 0 密钥已解密）；rate-cards（建卡事务内落全局兜底系数 3 位小数；
      PATCH coefficient 只触碰 scope='global' 行——M1 model 覆写行隔离；删除绑定守卫
      409；健康自检）；model-catalog+vendor-catalog（目录=内存货架不落库；导入单事务
      find-or-create provider/免费渠道 rpm20+额度预填、重复导入=价格更新确认 isFree
      随价重推导 R6、外部名冲突 409 整体回滚零残留 M3、首次缺 key 400、价格必填；
      源注册表装配注入可扩展 mock 源；29 厂商预设档案）。列表统一契约
      {rows,total,page,pageSize}+q 字面 %+排序白名单 400+分页钳制不 400+join 计数。
      共享层两小修：http cache.ts 失效函数改结构化 RedisLike（跨 ioredis 实例类型
      互换）；app error-map PG 翻译走 cause 链（drizzle 包装穿透）。根 pnpm dev 扩为
      v2 四件套（:8082 admin-api）。顺带清掉上轮未提交工作积欠、挡 `pnpm regress`
      （含 lint）的 lint 债七处文件：core redis.test 纯函数内联 / ai task-adapter
      upstreamError 外提 / domain subscription 测试 import 指正 / service
      generation-poll 未用导入 / worker generation-adapter 冗余 spread /
      gateway 23 处（未用导入×10、shadow 改名×5、泵循环状态对象化×2、
      makeApp 参数约定、fakeGuards 外提）——至此 regress 门禁恢复全绿。
      收尾两笔：①regress 门禁范围收敛——v1 六 app 结构性排除（--filter=!，
      与 pnpm dev 同口径；共享包 + v2 四件套共 32 任务），起因是 v1 worker 的
      decrypt 三参调用点在上轮删双 key 后 typecheck 报错（运行时无害，按
      「v1 报错不进门禁」既定规则）；②pipeline「长流续租」测试改为容忍
      settlement_pending|settled 二态——开发库常有活 worker（默认 1s 一轮）
      在测试观察窗内合法结算，回归点是误释放（released/dead=漏收）不是
      「别人合法结算」，默认门禁不得假设独占共享开发库。
      测试走真实会话链（种子管理员 + signSession Bearer），非中间件注入桩。
    - admin-api 切片二·用户资产（2026-08-19，+28 例至 99）：users（列表钱包富化
      balance/在Flight/creditLimit/availableBalance + 企业过滤闭包 enterprise=0/1 组合 q +
      列白名单永不回 passwordHash 三查 camel/snake/scrypt + 封禁语义 freezeReason 只随
      status=1 且解封清原因 + 换卡守卫卡存在且启用 + 邮箱变更同事务 advanceAnchor 全网
      下线 + 状态/限额变更清网关 Key 鉴权缓存 + set-password 本地账号守卫/默认卡「标准」
      绑定 + 全局系数 1.000 回填 onConflictDoNothing + 流水 wallet statement newest-first
      余额链 + 非法日期仍 400 + 调账幂等 idempotency-key 同键重放余额只动一次异参 409 +
      数值域 '1e309'/1e10 全 400）。keys 管理面（跨用户列表 q 搜用户邮箱 join 计数
      42P01 防线 + status 枚举 0..1 非法 99 400 + keyHash 不出库）。subscriptions
      管理面（续费/变更 userId=null 免属主 / 取消 CAS 0→2 无资金变动 / grantPack
      加油包发放有效订阅加额 + 列表双 join 计数）。plans（kind×periodDays 一致性：包月
      1..3650/加油包恒 0、kind 不可变 .strict()、价格 Infinity 400、删除守卫含已取消
      历史订阅 409 plan_in_use）。redeem 批次（count ≤10000/金额正数上限、明文码 RC-
      前缀仅 201 一次返回、码列表哈希脱敏 left8、作废 CAS 0→2 已废再废 404）。
      channel-funds（recharge 进货累加+熔断 3→0 自动复活+凭证 data URL 解析→本地存储
      换键回读 content-type、adjust 调后非负守卫 422 insufficient_budget、幂等 red 同键
      重放同 rechargeId 额度只加一次异参 409、上限 red 1e21 400 不触库、流水列表
      q 搜单号/备注/渠道名 join 计数 + 操作人邮箱回显）。共享层扩展：service 订阅域补
      cancel/grantPack 两动词（chargeCash 参数化 refType=pack；userId 类型 widen
      number|null——域内属主守卫原本就 null 直通）、domain 错误码联合 +subscription_inactive；
      repository 新增 redeem-batch 仓储 + user/api-key/plan/subscription/rate-card/
      channel 六仓储扩管理面方法（列表 ilike 转义/join 计数/审计日志/系数回填/资金
      流水）。error-map 补订阅域表 + 资金错误家谱 + HttpError 注册表穿透（operationId
      等共享组件错误免费获得 v1 注册表状态码）。config +ADMIN_CURRENCY/VOUCHER_*。
      顺带：service settlement-failure 测试同「活 worker 竞态」加固（外部 dev worker
      1s 抢领合法结算——终态轮询收敛断言）。
    - admin-api 质量收口（2026-08-19，138 例 19 文件 + E2E 18 例 4 文件）：
      ①覆盖率门禁（vitest coverage-v8，阈值 90/85/90/90；入口/装配/env 解析/
      测试基建不计入）——补异常/安全/攻击面五套件：auth-routes（HTTP 登录/验码/
      封禁 403）、security（CORS 白名单外无 ACAO、413 提前拒绝、幂等键含冒号抢占
      系统命名空间 400、篡改签名/过期/跨面 token 401、13 资源面未授权扫描、
      q 通配注入 %/_ 字面、XSS 载荷原样存 + nosniff、分页 NaN/钳制、凭证键穿越）、
      coverage-gaps（换卡 404/停用 400、邮箱变更 anchor、授信地板、2FA 验码后
      封禁 403/开关 404、plans 删除 happy、redeem 详情/过滤/过期、channels 阈值/
      探针内部异常结构化、models 多字段 PATCH、error-map 家谱穿透单元）、units
      （凭证存储边界、目录缓存命中 fetch 一次、2FA HTTP 全链、idParam 非法全路由
      扫、三过滤组合、全零价 isFree 合法翻转）。抓出并修 1 个真缺口：渠道探针
      未包 try/catch——适配器异常/密文损坏曾冒 500，现结构化 ok:false internal。
      ②E2E 通道（e2e-kit 真进程 port 0 + 种子管理员 HTTP 登录唯一凭证入口 +
      清理台账；复用 client-api e2e-kit 双 app 共库）：登录全链（改密→旧
      token 401→旧密码死→新密码登）、金钱链（进货凭证回读/调账/超扣 422/幂等
      重放预算只动一次；client 注册→admin 调账+赠送→client 购订阅→admin 续费→
      cancel→流水余额链 105/75/45 newest-first→admin 列表与 client 钱包余额同数字）、
      资源全扫（providers 改名退役/channels 换 Key 复位+禁用/models 绑定回显改价
      下架/rate-cards 系数改+绑用户+删除守卫/users 封禁解封+审计/plans 删/redeem
      作废）、跨 app（管理面改密/封禁→用户面旧 token 即刻 401）。E2E 抓出 3 处
      测试侧错（无 body POST 默认 GET、幂等键未复用、cancel 打旧订阅行）——
      均为测试口径修正非产品缺陷。
    - admin-api 切片三·运维查询 + 前端全量切 v2（2026-08-19，151 例 21 文件
      + E2E 23 例 5 文件；v1 22/22 模块全覆盖收官）：①运维查询族——usage-logs
      （estimated 字符串布尔显式解析防 coerce 陷阱、estimated/estimateReason 一等
      字段、恒 status=0、q 命中外部名/真实名/requestId::text）、logs（userName=
      displayName??email 回退、statusCode 2xx/4xx/5xx 分组在 DB 展开、缺省 30 天
      窗、q 命中 path/errorCode/sourceIp/requestId）、audit-logs（全局+用户维度）、
      payment-orders（q uuid/displayName 精确匹配 + 手动关单 CAS 0→4 拒已付）、
      generation-tasks（kind/status 过滤 + 账单状态 join + 页内批量实扣回填消 N+1）、
      stats（overview 今日/累计/渠道健康 + usage user/model/channel 三轴分组）、
      tracing（复用 tracing 包 PG 读侧：recent 24h 窗 errorsOnly/HAVING minDuration/
      瀑布/by-request 复核下钻/topology 渠道拓扑/stats 分区）、notifications
      （渠道 CRUD + webhook url+secret/email recipients 配置守卫 + 测试事件入箱）。
      ②billing-operations 死单复核——list（status=dead 专属）、retry（CAS dead→
      retry_wait + revision 乐观锁 + 结算退避清零 + 审计同事务）、abandon（CAS
      dead→released + createReleaseAllReservations 三路归还 wallet 授权/订阅配额/
      渠道敞口——归还失败随事务回滚 409）；幂等走 operations（billing.retry_dead/
      abandon_dead）；错误族 BILLING_* 注册表直通。③repository——usage-log 扩
      listAdminUsage/listRequestLogs/stats 四聚合、payment-order 扩 listAdminOrders/
      closeOrder、generation-task 扩 listAdminTasks/findSettledAmounts、新 notification
      （渠道 CRUD+outbox）/audit-log（全局列表+事务内写入+定向查询）两仓储。
      ④前端 admin/client 就地切 v2（不建 v2 前端）——packages/api-client 重写为
      v2 形态：Bearer（BFF 持 token 于 HttpOnly cookie，登录动作从响应体取 token
      写入；端口 8081/8082）、mapPath 路径归一（/api/admin/* 与 /api/* → /v1/*，
      特例 /api/admin/keys→/v1/admin-keys）、列表信封双读（rows??list 兼容）；
      两应用 auth server actions 改两步流（token 入体 cookie；改密轮换 token；
      注销=清本地）、pages 全量调用点修正（订阅/keys orgs+subscription 行、钱包
      statement 字段映射、billing 订单/渠道、dashboard by-model、capability 字段、
      OAuth 按钮 v1 路径+新增 /oauth/callback fragment 落地页、凭证代理 Bearer、
      payment-orders 误用 fetchUserList 修正、notifications/统计 rows??list）；
      client-api 补公开 /v1/pricing（价格页/操练场读模型）与 me profile 的
      isEnterprise。⑤浏览器级 UI E2E（真浏览器驱动生产构建前端 + 真 v2 双后端）：
      client 注册→自动登录→dashboard（余额/Key/速率卡片）→登出→重登→创建 Key
      （明文一次性显示+列表回显）；admin 登录（无 2FA 单步）→仪表盘（今日请求/
      消耗/渠道健康真数据）→用户列表（5616 用户钱包富化列）→赠送 100 元→余额列
      0→100.0000（管理写+用户读双端对账）。开发模式注意：Next dev 需
      allowedDevOrigins=['127.0.0.1','localhost'] 否则水合静态资源被拦（已写入
      两 next.config.mjs）；浏览器驱动 UI 测试建议跑生产构建（next start）。
    - v2 四应用收官审计（2026-08-19）：端点级逐一比对 v1↔v2 完成对位矩阵——
      admin 22/22 模块（admin-auth→auth+me、model-catalog+vendor-catalog→catalog、
      usage-logs+logs+payment-orders+stats+generation-tasks→ops 归并）；client 全
      端点（logout=Bearer 清 cookie 语义等价、apps rotate-secret→rotate 改名、
      usage summary 并入 by-model、pricing/public-pricing→/v1/pricing 本轮补）。
      明确未移植 1 件（顺序见基线待办）：
      playground（org 成员子配额经 2026-08-19 复核确认已在 service 资金域
      接线——SubscriptionSource.probe 消费 memberLimits；Stripe 渠道与
      referrals 邀请返利同日移植完成，见基线待办②③划线条目）。
      trace-receiver 已决策保持 v1（用户确认——无业务
      逻辑，collector 直对接；admin-api /v1/tracing 查询侧与 receiver 写侧
      共享同一 PG 存储，天然兼容）。全栈健康快照：regress 32/32 + client-api
      108 + admin-api 151 集成 + 23 E2E + 双前端 production build 通过 +
      真浏览器 UI 全链。
  - 相邻域用例：subscription 生命周期（购买/续费/换包，进 service/subscription）、渠道充值/调账
    （进 service/channel-budget）、死单复核（admin-api）；
  - v1/v2 共存清理：**需用户逐项确认后执行**。

---

## 8. 当前状态快照（2026-08-19）

> **当前基线**（随每轮更新；下方条目是按时间的完成留痕）：
> 默认门禁 `pnpm regress`（v2 四件套 + 共享包 32 任务：typecheck/lint/test 全绿）——
> domain 124 / service 98 / repository 5 / core 14+5skip(Redis) / ai 299 / gateway 97 /
> worker 7 / client-api 108 / **admin-api 151**（21 文件；覆盖率门禁
> 语句 94.5%/分支 85.1%/函数 97.7%/行 96.0%，阈值 90/85/90/90；**22/22 v1 模块
> 全覆盖**）。前端 admin/client 已就地切换 v2 后端（见 §8 末条）。
> admin-api E2E 独立通道 `pnpm --filter @ai-gateway/admin-api test:e2e`
> （23 例 5 文件：①登录全链含改密全网下线 ②金钱计算链——双 app 共库真进程：
> 进货/调账/幂等重放/凭证回读 + client 注册→admin 入金→client 购订阅→admin
> 续费/取消→双面余额对账同一数字 ③新增接口+状态修改全扫 ④跨 app——管理面
> 改密/封禁 → 用户面旧 token 即刻 401 ⑤运维查询全扫——stats/usage-logs/logs/
> audit/payment-orders/generation-tasks/billing-operations/tracing 五端点/
> notifications CRUD）。
> E2E 独立通道两处（依赖外网与 dev 库，不进默认门禁）：
> `pnpm --filter gateway test:e2e`（25 例）+ `pnpm --filter @ai-gateway/client-api test:e2e`
> （22 例 4 文件：①用户全链 ②组织团队 ③OAuth mock GitHub 全链 ④跨 app——client-api 注册
> 充值开 Key → 真网关 RX-M3 消费 → 结算对账 → 吊销即阻断）。E2E 四轮抓修 4 个真 bug：
> 流式换渠死锁 / S1 requestId 信任（限流绕过）/ max_tokens 直通 / floor 封顶投影死信。
> 待办（v2 四应用收官审计 2026-08-19）：四应用 v1 模块已 100% 对位 v2
> （gateway/worker/client-api/admin-api 全绿；admin 22/22 模块、client 端点
> 逐一对位矩阵见 §8 末条）。**剩余 1 个功能件未移植 v2**（v1 自身无测试，
> 不在语义覆盖基线内）：
> ④ playground 操练场推理（chat/completions SSE——v1 调用点本就未被 nginx
>   路由，latent 功能，需一并设计前端代理）。
> ~~① org 成员子配额授权侧执行~~（2026-08-19 复核撤销——审计结论过时：
> 资金域重写时已接线，gateway assembly → createBillingDomain → 默认
> funding registry → SubscriptionSource.probe 消费 orgMember.memberLimits，
> domain subscriptionAvailability 执行 a 日限/b 月配额双闸（含 PAYG 回退拆分：
> 限额只封顶订阅份额、缺口走个人余额）；管理面 admin/client-api 可设置。
> 补服务级集成测试 3 例——月配额拦截 / 回退瀑布两源拆分 / 越权，服务包
> 100/100 全绿）；
> ~~② Stripe 支付渠道~~（2026-08-19 移植完成：client-api 多渠道化——
> PaymentProviderPort 从单渠道改 providers 数组，domain/stripe.ts 纯规则
> （HMAC-SHA256 恒定时间验签 + 300s 重放窗 + checkout.session.completed
> 事件归一 + 分↔元整数转换），createStripeProvider 适配（Checkout Session
> form-encoded 无 SDK，fetch/clock/apiBase 可注入）；下单 provider 可选
> （单渠道直通/多渠道须显式/未启用 503 fail-closed），回调
> POST /v1/payments/notify/:provider 按渠道分派（stripe 走原始体+签名头，
> 2xx 确认/400 触发渠道重试），新增 GET /v1/payments/channels；配置
> STRIPE_* 四件套成组 fail-closed（部分配置=启动失败）+ STRIPE_API_BASE
> 覆盖。金额闸与幂等语义同 epay（creditAmount 创建时定死、金额核对第二道闸、
> refKey=orderId 入账幂等）。测试：stripe 单元 12 + 支付集成 21（含资损
> 不变量：错密钥/篡改载荷/过期时间戳/金额篡改全拒 + 防御路径仓储桩 4 例）
> + 路由层 3；前端 billing 页改读 channels 端点。app 134→144 例全绿，
> 新文件覆盖率 96.4/89.0/96.9/99.3）；
> ~~③ referrals 邀请返利~~（2026-08-19 移植完成：aff 码 = u{base36(userId)}
> 与 v1 同格式（历史链接继续有效）；repository 新增 referral.repo（invitee
> 唯一插入/邀请人有效性/名单/日结聚合）+ wallet.sumCreditedByRefPrefix
> 聚合读；client-api domain/referral.ts 纯规则 + referral.service
> （注册归因尽力而为不阻断 + 双方奖励 wallet 自然键幂等 + 概览）；
> auth register/verifyRegistration 双入口接 aff（单步+两步），路由
> GET /v1/referrals；worker 佣金日结任务（昨日 UTC 窗口 × 比例 →
> wallet.credit 自然键幂等，重放不计数）；配置 REFERRAL_SIGNUP_BONUS/
> REFERRAL_COMMISSION_RATE/WORKER_REFERRAL_INTERVAL_MS，wallet 白名单
> 两 app 加 'referral'。测试：client 10 例 + 路由全链 1 例 + worker 4 例，
> 新文件覆盖率 100/95/100/100；前端邀请页真实数据 + aff 透传，真浏览器
> 走通「邀请链接 → 注册 → 归因 → 名单可见」全链）。
> 部署面已决策（用户确认 2026-08-19）：apps/trace-receiver（OTLP span 接收
> :8788）**保持 v1 代码，不移植**——只依赖共享 @ai-gateway/tracing 包、无业务
> 逻辑；OTEL_TRACES_MODE=off 不参与链路，开 otlp 时由 collector 直对接。
> 管理面 tracing 查询（admin-api /v1/tracing/* 五端点）读同一 PG 存储，
> 与 receiver 写侧天然兼容。
> ~~低优先遗留：TPM actual 结算回填~~（2026-08-20 §11 Wave1 已补：backfillTpm + onSettled 钩子）。
> v1/v2 共存清理（删 v1 应用代码）仍待用户逐项确认。
