/**
 * @ai-gateway/repository —— 数据访问层（唯一允许出现 SQL 的包）。
 *
 * 消费方式：每个表/聚合一个 Repository 类（无状态，方法统一接收 RepoContext），
 * `createRepositories()` 组合全部实例；服务层经 env 注入所需仓储：
 *
 *   const repos = createRepositories();                    // 进程级单例
 *   const billing = createBillingDomain({ db, wallet, repos });
 *
 * 契约：
 *   - 方法 = 意图化原子操作（守卫 UPDATE / SKIP LOCKED / CAS 的原子性是方法边界）
 *   - 写路径 RepoContext.db 必须是事务句柄（事务由 app 用例层持有并注入）
 *   - 返回行形状（string 金额），语义判定与错误翻译在 app 的 domain/services
 *   - 本包只依赖 packages/db 与 drizzle-orm，不 import 任何 app
 */
export type { Actor, DbLike, RepoContext } from './context.js';
/** db 连接类型再导出：service 层经本包取类型，运行时依赖箭头保持 service→repository→db */
export type { Db, DbTx } from '@ai-gateway/db';

import { WalletRepository } from './wallet.repo.js';
import { BillingRequestRepository } from './billing-request.repo.js';
import { BillingReservationRepository } from './billing-reservation.repo.js';
import { UsageLogRepository } from './usage-log.repo.js';
import { CredentialRepository } from './credential.repo.js';
import { UserRepository } from './user.repo.js';
import { PlanRepository } from './plan.repo.js';
import { OrgMemberRepository } from './org-member.repo.js';
import { ReferralRepository } from './referral.repo.js';
import { SubscriptionRepository } from './subscription.repo.js';
import { ChannelRepository } from './channel.repo.js';
import { OperationsRepository } from './operations.repo.js';
import { RatingRepository } from './rating.repo.js';
import { FxRepository } from './fx.repo.js';
import { HealthRepository } from './health.repo.js';
import { ModelMappingRepository } from './model-mapping.repo.js';
import { GenerationTaskRepository } from './generation-task.repo.js';
import { UserAccountRepository } from './user-account.repo.js';
import { ApiKeyRepository } from './api-key.repo.js';
import { RedeemCodeRepository } from './redeem-code.repo.js';
import { PaymentOrderRepository } from './payment-order.repo.js';
import { OrgRepository } from './org.repo.js';
import { AppsRepository } from './apps.repo.js';
import { AdminAccountRepository } from './admin-account.repo.js';
import { ProviderRepository } from './provider.repo.js';
import { RateCardRepository } from './rate-card.repo.js';
import { RedeemBatchRepository } from './redeem-batch.repo.js';
import { NotificationRepository } from './notification.repo.js';
import { AuditLogRepository } from './audit-log.repo.js';

export {
  WalletRepository,
  FxRepository,
  BillingRequestRepository,
  BillingReservationRepository,
  UsageLogRepository,
  CredentialRepository,
  UserRepository,
  PlanRepository,
  OrgMemberRepository,
  SubscriptionRepository,
  ChannelRepository,
  OperationsRepository,
  RatingRepository,
  HealthRepository,
  ModelMappingRepository,
  GenerationTaskRepository,
  UserAccountRepository,
  ApiKeyRepository,
  RedeemCodeRepository,
  PaymentOrderRepository,
  OrgRepository,
  AppsRepository,
  AdminAccountRepository,
  ProviderRepository,
  RateCardRepository,
  RedeemBatchRepository,
  NotificationRepository,
  AuditLogRepository,
};
export type { DeadCaseRow } from './billing-request.repo.js';
export type * from './wallet.repo.js';
export type * from './billing-request.repo.js';
export type * from './billing-reservation.repo.js';
export type * from './usage-log.repo.js';
export type * from './credential.repo.js';
export type * from './user.repo.js';
export type * from './plan.repo.js';
export type * from './org-member.repo.js';
export type * from './subscription.repo.js';
export type * from './channel.repo.js';
export type * from './operations.repo.js';
export type * from './fx.repo.js';
export { CATALOG_FX_CONFIG_KEY, FX_CACHE_MS } from './fx.repo.js';
export type * from './health.repo.js';
export type * from './model-mapping.repo.js';
export type * from './generation-task.repo.js';
export type * from './user-account.repo.js';
export type * from './api-key.repo.js';
export type * from './redeem-code.repo.js';
export type * from './payment-order.repo.js';
export type * from './org.repo.js';
export type * from './apps.repo.js';
export type * from './admin-account.repo.js';
export type * from './provider.repo.js';
export type * from './rate-card.repo.js';
export type * from './redeem-batch.repo.js';
export type * from './notification.repo.js';
export type * from './audit-log.repo.js';

/** 全部仓储的组合形状（服务层 env 的注入类型） */
export interface Repositories {
  wallet: WalletRepository;
  billingRequest: BillingRequestRepository;
  billingReservation: BillingReservationRepository;
  usageLog: UsageLogRepository;
  credential: CredentialRepository;
  user: UserRepository;
  plan: PlanRepository;
  orgMember: OrgMemberRepository;
  referral: ReferralRepository;
  subscription: SubscriptionRepository;
  channel: ChannelRepository;
  operations: OperationsRepository;
  rating: RatingRepository;
  fx: FxRepository;
  health: HealthRepository;
  modelMapping: ModelMappingRepository;
  generationTask: GenerationTaskRepository;
  userAccount: UserAccountRepository;
  apiKey: ApiKeyRepository;
  redeemCode: RedeemCodeRepository;
  paymentOrder: PaymentOrderRepository;
  org: OrgRepository;
  apps: AppsRepository;
  adminAccount: AdminAccountRepository;
  provider: ProviderRepository;
  rateCard: RateCardRepository;
  redeemBatch: RedeemBatchRepository;
  notification: NotificationRepository;
  auditLog: AuditLogRepository;
}

/** 组合根：无状态实例集（进程级单例安全；测试可整体替换或逐个替换） */
export function createRepositories(): Repositories {
  return {
    wallet: new WalletRepository(),
    billingRequest: new BillingRequestRepository(),
    billingReservation: new BillingReservationRepository(),
    usageLog: new UsageLogRepository(),
    credential: new CredentialRepository(),
    user: new UserRepository(),
    plan: new PlanRepository(),
    orgMember: new OrgMemberRepository(),
    referral: new ReferralRepository(),
    subscription: new SubscriptionRepository(),
    channel: new ChannelRepository(),
    operations: new OperationsRepository(),
    rating: new RatingRepository(),
    fx: new FxRepository(),
    health: new HealthRepository(),
    modelMapping: new ModelMappingRepository(),
    generationTask: new GenerationTaskRepository(),
    userAccount: new UserAccountRepository(),
    apiKey: new ApiKeyRepository(),
    redeemCode: new RedeemCodeRepository(),
    paymentOrder: new PaymentOrderRepository(),
    org: new OrgRepository(),
    apps: new AppsRepository(),
    adminAccount: new AdminAccountRepository(),
    provider: new ProviderRepository(),
    rateCard: new RateCardRepository(),
    redeemBatch: new RedeemBatchRepository(),
    notification: new NotificationRepository(),
    auditLog: new AuditLogRepository(),
  };
}
