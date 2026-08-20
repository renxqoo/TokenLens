/**
 * 与 admin-api 通信的共享类型（对齐后端真实字段名，全 camelCase）。
 * 后端唯一蛇形字段：分页 envelope 的 `page_size`。
 */

/** admin-api 标准错误结构（取自 { error: { message, code, details } }） */
export interface ApiErrorBody {
  message: string;
  code?: string;
  details?: unknown;
}

/** 当前登录用户 (GET /api/me，client-api 用户面) */
export interface MeInfo {
  id: number;
  subject: string;
  email: string | null;
  displayName: string | null;
  rateCardId: number | null;
  rateCardName: string | null;
  balance: string;
  status: number;
  isEnterprise: boolean;
  rpmLimit: number | null;
  tpmLimit: number | null;
  lastLoginAt: string | null;
  createdAt: string;
}

/** 当前登录管理员 (GET /api/admin/me，admin-api 管理面) */
export interface AdminMeInfo {
  id: number;
  email: string;
  displayName: string | null;
  lastLoginAt: string | null;
  /** 邮箱验证码二次登录已开启 */
  twoFactorEnabled?: boolean;
}

/**
 * 统一分页 envelope（v2 正位 {rows,total,page,limit}，配套 ?page=&limit= 查询参数）。
 */
export interface Paginated<T> {
  rows: T[];
  total: number;
  page: number;
  limit: number;
}

// ── Key (GET/POST /api/keys) ────────────────────────────────────────────────
export interface KeyRow {
  id: number;
  keyPreview: string;
  name: string;
  remark: string | null;
  /** 计费来源：NULL=余额；非空=扣该订阅额度（个人/组织订阅）。 */
  subscriptionId: number | null;
  status: number;
  rpmLimit: number | null;
  tpmLimit: number | null;
  /** Key 级每日花费上限（元，NULL=不限）。 */
  dailySpendLimit: string | null;
  expiresAt: string | null;
  lastUsedAt: string | null;
  createdAt: string;
}
export interface KeyCreated {
  id: number;
  name: string;
  plaintext: string;
}

// ── App (GET/POST /api/apps) ────────────────────────────────────────────────
export interface AppRow {
  id: number;
  appId: string;
  clientId: string;
  name: string;
  description: string | null;
  scope: string | null;
  status: number;
  createdAt: string;
  rotatedAt: string | null;
}
export interface AppCreated {
  id: number;
  appId: string;
  clientId: string;
  name: string;
  clientSecret: string;
}

// ── Transactions (GET /api/me/transactions, /api/admin/users/:id/transactions) ─
export interface TransactionRow {
  id: number;
  userId: number;
  type: string;
  amount: string;
  balanceBefore: string;
  balanceAfter: string;
  refType: string | null;
  refId: string | null;
  remark: string | null;
  createdAt: string;
}

/** 管理面交易行（GET /api/admin/users/:id/transactions；多操作管理员字段，终端用户不可见） */
export interface AdminTransactionRow extends TransactionRow {
  createdBy: number | null;
}

/** 我的充值码兑换记录（GET /api/redeem/history；不含明文码/哈希） */
export interface RedeemHistoryItem {
  id: number;
  /** 面值（元） */
  amount: string;
  /** 批次名 */
  batchName: string;
  /** 兑换时间 */
  usedAt: string | null;
}

// ── Usage (GET /api/usage) ──────────────────────────────────────────────────
export interface UsageRow {
  id: number;
  requestId: string;
  userId: number;
  appId: number | null;
  apiKeyId: number | null;
  externalModel: string;
  realModel: string;
  channelId: number | null;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  amount: string;
  /** 计费来源：plan=套餐额度（展示积分）/ payg=余额（展示金额） */
  billedBy: 'plan' | 'payg';
  planAmount: string;
  paygAmount: string;
  upstreamCost: string | null;
  durationMs: number;
  createdAt: string;
  /** 凭证类型：key（API Key）/ jwt（应用） */
  credentialType: string;
  /** 来源 API Key 名称（credentialType=key 时有值） */
  keyName: string | null;
  /** 来源应用名称（credentialType=jwt 时有值） */
  appName: string | null;
}

// ── Usage Summary (GET /api/usage/summary) ──────────────────────────────────
export interface UsageSummaryItem {
  date: string;
  requests: number;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  /** 金额字符串（numeric 全精度；图表端按需 Number() 展示） */
  cost: string;
}

/** 用量按模型聚合（GET /api/usage/by-model） */
export interface UsageByModelItem {
  model: string;
  requests: number;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  /** 金额字符串（numeric 全精度；图表端按需 Number() 展示） */
  cost: string;
}

// ── Admin: Users (GET /api/admin/users) ─────────────────────────────────────
export interface AdminUserRow {
  id: number;
  issuer: string | null;
  subject: string;
  identityProvider: string | null;
  email: string | null;
  displayName: string | null;
  rateCardId: number | null;
  rateCardName: string | null;
  balance: string;
  reservedBalance: string;
  availableBalance: string;
  /** 透支上限（元，>=0）。信用模型：balance 允许降到 -creditLimit。 */
  creditLimit: string;
  /** 每日花费上限（元，NULL=不限）。 */
  dailySpendLimit: string | null;
  status: number;
  isEnterprise: boolean;
  freezeReason: string | null;
  rpmLimit: number | null;
  tpmLimit: number | null;
  lastLoginAt: string | null;
  createdAt: string;
}

// ── Admin: Channels (GET /api/admin/channels) ───────────────────────────────
export interface AdminChannelRow {
  id: number;
  providerId: number;
  name: string;
  baseUrlOverride: string | null;
  models: string | null;
  weight: number;
  priority: number;
  status: number;
  failCount: number;
  cooldownUntil: string | null;
  rpmLimit: number | null;
  tpmLimit: number | null;
  /** 进货总额（元，numeric 字符串） */
  upstreamBudget: string;
  /** 熔断阈值（元，string | null） */
  upstreamThreshold: string | null;
  /** 已消耗上游成本（元，string） */
  upstreamConsumed: string;
  /** 剩余 = 进货 - 已消耗（元，string） */
  upstreamRemaining: string;
  createdAt: string;
  updatedAt: string;
  providerName: string;
  providerBaseUrl: string;
  boundModels: Array<{ externalName: string; realModel: string }>;
}
/** 模型白名单线上契约是数组（DB jsonb / GET 响应 / import 同口径）；
 * 逗号分隔文本是管理端表单的 UX 形态，转换收口在 admin server action 边界。 */
export interface ChannelCreateBody {
  providerId: number;
  name: string;
  apiKey: string;
  baseUrlOverride?: string;
  models?: string[] | null;
  weight?: number;
  priority?: number;
}
export interface ChannelUpdateBody {
  name?: string;
  apiKey?: string;
  baseUrlOverride?: string;
  models?: string[] | null;
  weight?: number;
  priority?: number;
  status?: number;
  /** null=不限流（继承用户/全局），与后端 channelUpdateSchema 对齐。 */
  rpmLimit?: number | null;
  tpmLimit?: number | null;
  /** 熔断阈值（元，>=0），null=0（耗尽才熔断）。与后端 channelUpdateSchema 对齐。 */
  upstreamThreshold?: number | null;
}
export interface ChannelTestResult {
  ok: boolean;
  durationMs: number;
  /** 后端返回 string 或 { code, message } */
  error?: string | { code?: string; message?: string };
  keyPreview?: string;
}

// ── Admin: Providers (GET /api/admin/providers) ─────────────────────────────
export interface AdminProviderRow {
  id: number;
  name: string;
  baseUrl: string;
  protocol: string;
  /** 厂商档案引用（VENDOR_PROFILES 词表键；null = 无档案纯透传） */
  vendor: string | null;
  status: number;
  createdAt: string;
  /**
   * providers 表当前无 updated_at 列，接口实际不返回该字段（undefined）。
   * 前端展示需做空值兜底（回退 createdAt）。
   */
  updatedAt?: string;
}
export interface ProviderCreateBody {
  name: string;
  baseUrl: string;
  protocol?: string;
  status?: number;
}

// ── Admin: Models (GET/POST /api/admin/models) ──────────────────────────────
export interface AdminModelRow {
  id: number;
  externalName: string;
  realModel: string;
  inputPrice: string;
  outputPrice: string;
  cacheInputPrice: string;
  cacheWritePrice: string;
  isFree: boolean;
  contextLength: number | null;
  fallbackModels: string | null;
  paramRules: string | null;
  billingPolicy: Record<string, unknown> | null;
  rpmLimit: number | null;
  tpmLimit: number | null;
  status: number;
  createdAt: string;
  updatedAt: string;
  /** 已绑定的渠道 id（供「绑定渠道」弹窗回显已选） */
  channelIds: number[];
}
export interface ModelCreateBody {
  externalName: string;
  realModel: string;
  inputPrice: string | number;
  outputPrice: string | number;
  cacheInputPrice?: string | number;
  isFree?: boolean;
  billingPolicy?: Record<string, unknown> | null;
}
export interface ModelUpdateBody {
  externalName?: string;
  realModel?: string;
  inputPrice?: string | number;
  outputPrice?: string | number;
  cacheInputPrice?: string | number;
  isFree?: boolean;
  fallbackModels?: string;
  paramRules?: string;
  billingPolicy?: Record<string, unknown> | null;
  rpmLimit?: number;
  tpmLimit?: number;
  status?: number;
}

// ── 组织/成员（GET /api/orgs）─────────────────────────────────────────────
export interface OrgRow {
  orgId: number;
  name: string;
  role: 'owner' | 'member';
  /** 组织当前 active 订阅 id（无套餐为 null） */
  subscriptionId: number | null;
  planName: string | null;
  /** 席位（成员名额，无订阅为 null） */
  quantity: number | null;
  quotaAmount: string | null;
  usedAmount: string | null;
  reservedAmount: string | null;
  /** 组织订阅剩余额度（quota−used−reserved，无订阅为 0） */
  remainingAmount: string;
}
export interface OrgMemberRow {
  userId: number;
  role: string;
  status: number;
  dailySpendLimit: string | null;
  monthlyQuota: string | null;
  email: string | null;
  displayName: string | null;
}
export interface OrgInvitationSummary {
  id: number;
  email: string;
  status: number;
  expiresAt: string;
  createdAt: string;
}

export interface OrgDetail {
  org: { id: number; name: string; ownerUserId: number } | null;
  members: OrgMemberRow[];
  /** 待接受邀请（仅 owner 可见；token 不回显——链接只在邀请创建时下发一次） */
  invitations?: OrgInvitationSummary[];
}

// ── Admin: Keys (GET/PATCH /api/admin/keys) ─────────────────────────────────
export interface AdminKeyRow {
  id: number;
  /** 脱敏预览 ag_****abcd（明文永不回显） */
  keyPreview: string;
  name: string;
  remark: string | null;
  /** 计费来源：NULL=余额；非空=扣该订阅额度。 */
  subscriptionId: number | null;
  userId: number;
  userEmail: string | null;
  userDisplayName: string | null;
  rpmLimit: number | null;
  tpmLimit: number | null;
  /** Key 级每日花费上限（元，NULL=不限）。 */
  dailySpendLimit: string | null;
  status: number;
  lastUsedAt: string | null;
  createdAt: string;
}
export interface AdminKeyUpdateBody {
  name?: string;
  /** null=不限流（继承用户/全局） */
  rpmLimit?: number | null;
  tpmLimit?: number | null;
  /** Key 级每日花费上限（元，NULL=不限）。 */
  dailySpendLimit?: number | null;
  status?: number;
}

// ── Admin: Channel Funds (GET/POST /api/admin/channel-funds) ────────────────
export interface AdminChannelFundRow {
  id: number;
  channelId: number;
  channelName: string;
  /** recharge（入货）/ adjust（调账） */
  type: 'recharge' | 'adjust';
  /** 有符号金额（元，numeric 字符串） */
  amount: string;
  /** 变动后渠道额度余额快照（元） */
  balanceAfter: string;
  /** 支付订单号 */
  orderNo: string | null;
  /** 支付凭证 key（本地磁盘 / 未来 OSS） */
  voucher: string | null;
  remark: string | null;
  adminId: number | null;
  adminEmail: string | null;
  adminDisplayName: string | null;
  createdAt: string;
}

// ── Admin: Rate Cards (GET/POST /api/admin/rate-cards) ──────────────────────
export interface AdminRateCardRow {
  id: number;
  name: string;
  description: string | null;
  status: number;
  createdAt: string;
  updatedAt: string;
  coefficient: string;
}
export interface RateCardCreateBody {
  name: string;
  description?: string;
  coefficient: number | string;
}
export interface RateCardUpdateBody {
  name?: string;
  description?: string;
  status?: number;
  coefficient?: number | string;
}

// ── Admin: Redeem Batches (GET/POST /api/admin/redeem-batches) ──────────────
export interface AdminBatchRow {
  id: number;
  name: string;
  remark: string | null;
  amount: string;
  total: number;
  usedCount: number;
  createdBy: string;
  createdAt: string;
}
export interface BatchCreateBody {
  name: string;
  remark?: string;
  amount: number;
  count: number;
  expiresAt?: string;
}
export interface BatchCreated {
  batch: { id: number; name: string; amount: string; total: number };
  codes: string[];
}
export interface RedeemCodeRow {
  id: number;
  codeMasked: string;
  status: number;
  usedBy: string | null;
  usedAt: string | null;
  expiresAt: string | null;
}

// ── Admin: Stats (GET /api/admin/stats/*) ───────────────────────────────────
export interface StatsOverview {
  today: {
    requests: number;
    inputTokens: number;
    outputTokens: number;
    cost: string | number;
    successCount: number;
    failedCount: number;
    successRate: number;
  };
  total: { cost: string | number; requests: number };
  channelHealth: Array<{ status: number; count: number }>;
}
export interface StatsUsageItem {
  key: string;
  requests: number;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  cost: string | number;
  upstreamCost: string | number;
}
export interface LogRow {
  id: number;
  requestId: string;
  userId: number;
  /** 用户名（displayName 优先，其次 email；LEFT JOIN users，可能为 null） */
  userName: string | null;
  apiKeyId: number | null;
  method: string;
  path: string;
  statusCode: number;
  errorCode: string | null;
  durationMs: number;
  requestSummary: {
    model: string;
    stream: boolean;
    max_tokens: number;
    messageCount: number;
  } | null;
  attempts: number;
  /** 来源 IP（X-Forwarded-For 首段 / X-Real-IP / socket，鉴权前记录） */
  sourceIp: string | null;
  createdAt: string;
}
/** 管理端用量明细行（GET /api/admin/usage-logs）——估算扣款一等字段 */
export interface AdminUsageRow {
  id: number;
  requestId: string;
  userId: number;
  userName: string | null;
  credentialType: string;
  externalModel: string;
  realModel: string;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  amount: string;
  calculatedAmount: string;
  planAmount: string;
  paygAmount: string;
  billedBy: string;
  upstreamCost: string | null;
  durationMs: number;
  stream: boolean;
  streamAborted: boolean;
  /** 估算结算标记（2026-08-17 政策）：用户取消/完成缺 usage 按估算扣款 */
  estimated: boolean;
  /** 估算归属（estimated=true 时有值） */
  estimateReason: string | null;
  createdAt: string;
}

export interface AuditLogRow {
  id: number;
  adminId: number | null;
  actor: string | null;
  adminSubject: string | null;
  action: string;
  targetType: string;
  targetId: string;
  detail: Record<string, unknown> | string | null;
  createdAt: string;
}

// ── 下拉选项（页面从列表行投影的 client-safe 选项，单一真相）──────────────
/** 供应商下拉选项（渠道表单用，来源 AdminProviderRow）。 */
export interface ProviderOption {
  id: number;
  name: string;
  baseUrl: string;
  protocol: string;
  status: number;
}
/** 渠道下拉选项（统一形状：models 绑定弹窗展示 providerName，channel-funds 仅用 id/name）。 */
export interface ChannelOption {
  id: number;
  name: string;
  providerName?: string;
}
/** 费率卡下拉选项（用户绑定费率卡用，来源 AdminRateCardRow）。 */
export interface RateCardOption {
  id: number;
  name: string;
  coefficient: string;
}
/** 订阅「变更」弹窗的目标套餐选项（仅 subscription）。 */
export interface PlanOption {
  id: number;
  name: string;
  kind: 'subscription' | 'pack';
  sortOrder: number | null;
}

// ── 套餐订阅（包月）────────────────────────────────────────────────────────
/** plans 表行（amount 均为元 numeric 字符串）。 */
export interface PlanRow {
  id: number;
  name: string;
  kind: 'subscription' | 'pack';
  sortOrder: number | null;
  price: string;
  periodDays: number;
  quotaAmount: string;
  allowSeats: boolean;
  status: number;
}
export interface PlanCreateBody {
  name: string;
  kind?: 'subscription' | 'pack';
  sortOrder?: number | null;
  price: number;
  /** 包月套餐必填 1~3650；加油包传 0 或省略 */
  periodDays?: number;
  quotaAmount: number;
  allowSeats?: boolean;
}
export interface PlanUpdateBody {
  name?: string;
  /** kind 创建后不可变，更新接口不接受 */
  sortOrder?: number | null;
  price?: number;
  periodDays?: number;
  quotaAmount?: number;
  allowSeats?: boolean;
  status?: number;
}

/** 当前订阅摘要（client GET /api/me/subscription）。 */
export interface CurrentSubscription {
  id: number;
  planId: number;
  planName: string;
  planSortOrder: number | null;
  /** 是否支持席位（团队套餐）；false=个人套餐固定 1 席 */
  allowSeats: boolean;
  quantity: number;
  startAt: string;
  endAt: string;
  quotaAmount: string;
  usedAmount: string;
  reservedAmount: string;
  remainingAmount: string;
  price: string;
  /** 周期天数（30/365） */
  periodDays: number;
  /** 续费总价（元）= 当前档价 × 席位 */
  renewPrice: string;
  /** 当前档单价（元/席） */
  planPrice: string;
  /** 剩余价值（元）= 总价 × (额度-已用-在途)/额度 */
  remainingValue: string;
}

/** 订阅购买/续费/变更结果。 */
export interface SubscribeResult {
  userId: number;
  subscriptionId: number;
  planId: number;
  planName: string;
  quantity: number;
  startAt: string;
  endAt: string;
  quotaAmount: string;
  price: string;
  balanceBefore: string;
  balanceAfter: string;
  replayed: boolean;
}

/** admin 订阅列表行。 */
export interface AdminSubscriptionRow {
  id: number;
  userId: number;
  userSubject: string;
  userDisplayName: string | null;
  planId: number;
  planName: string;
  startAt: string;
  endAt: string;
  quotaAmount: string;
  usedAmount: string;
  reservedAmount: string;
  quantity: number;
  price: string;
  remainingAmount: string;
  status: number;
  createdAt: string;
}
