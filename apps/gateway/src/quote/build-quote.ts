/**
 * 报价构建（app 编排）：外部模型名 → 在架映射候选链（主 + fallback）→ BillingQuote。
 * 候选链解析/系数挑选/免费判定全部依赖 domain 规则与 repository 查询——本层零业务规则。
 *
 *   链序 = 主模型在前、fallback 按配置序（缺名/下架跳过——老网关语义）
 *   系数按各候选自己的映射解析（model > group > global；费率卡停用拒绝新请求）
 *   explicitlyFree = 候选链全部免费（混链按最贵候选预扣——防 fallback 落地免费漏洞）
 *   单价 = 定价策略（层 2）按 billingConfig 解析；单位上界 = 计量注册表（层 1）按
 *   pricingUnit 从 body 推 + 预扣策略（层 3）保底只抬不降
 *   inputTokenUpperBound / maxOutputTokens 由调用方（管线 G4）供
 */
import { createHash } from 'node:crypto';
import {
  measurementOf,
  pickCoefficient,
  reservationStrategyOf,
  strategyOf,
  type BillingConfig,
  type BillingQuote,
  type BillingQuoteCandidate,
} from '@ai-gateway/domain';
import type { Db, Repositories } from '@ai-gateway/repository';
import { createRepositories } from '@ai-gateway/repository';
import type { RunContext } from '@ai-gateway/service';
import { readOnly } from '@ai-gateway/service';
import { AppError } from '../http/error-map.js';

export interface BuildQuoteInput {
  model: string;
  userId: number;
  /** 输入 token 上界（管线 G4 的估算口径） */
  inputTokenUpperBound: number;
  /** 归一化后的输出 token 上界（n 倍数已含） */
  maxOutputTokens: number;
  /** 原始请求体——变体定价选择器与计量描述符（单位上界）都从中取值 */
  body?: Record<string, unknown>;
}

function policyFingerprint(policy: Record<string, unknown> | null): string | null {
  return policy ? createHash('sha256').update(JSON.stringify(policy)).digest('hex') : null;
}

export function createBuildQuote(deps: { db: Db; repos?: Repositories }) {
  const repos = deps.repos ?? createRepositories();
  return async function buildQuote(ctx: RunContext, input: BuildQuoteInput): Promise<BillingQuote> {
    const c = readOnly(ctx, deps.db);

    const main = await repos.modelMapping.findActiveByExternalName(c, input.model);
    if (!main) {
      throw new AppError(404, 'model_not_found', `模型「${input.model}」不存在或已下架`);
    }

    const chain = [main];
    const fallbackNames = main.fallbackModels ?? [];
    if (fallbackNames.length > 0) {
      const batch = await repos.modelMapping.findActiveByExternalNames(c, fallbackNames);
      for (const name of fallbackNames) {
        const mapping = batch.get(name);
        if (mapping) chain.push(mapping);
      }
    }

    // 费率卡快照：停用卡拒绝新请求（静态 Key 与 JWT 同语义）
    const rateCardId = await repos.user.findRateCardId(c, input.userId);
    const snapshot =
      rateCardId != null ? await repos.rating.loadRateCardCoefficients(c, rateCardId) : null;
    if (snapshot != null && snapshot.status !== 0) {
      throw new AppError(403, 'rate_card_disabled', '账户绑定的费率卡已停用，请联系管理员');
    }

    // externalModel 一律用请求名（收据验收的锚——fallback 候选也以请求名授权，老网关语义）
    const candidates: BillingQuoteCandidate[] = chain.map((mapping) => {
      const billingConfig = (mapping.billingConfig ?? {}) as BillingConfig;
      // 计量维度（层 1）：按映射声明的 pricingUnit 从请求体推预扣上界
      const measured = measurementOf(mapping.pricingUnit).unitsUpperBoundOf(input.body ?? {});
      // 预扣策略（层 3）：单位保底只抬不降（视频「至少 5 秒的钱」/图片「至少 1 张的钱」）
      const reservation = billingConfig.reservation ?? {};
      const unitFloor = reservationStrategyOf(reservation).unitFloorOf(reservation);
      const unitUpperBound = unitFloor != null ? Math.max(measured, unitFloor) : measured;
      // 定价策略（层 2）：按 billingConfig 选公式，解析出本请求的单价
      //（body 已知 → 变体即确定，单一价格快照 hold == settle）
      const resolvedUnitPrice = strategyOf(billingConfig).settleUnitPrice({
        units: unitUpperBound,
        body: input.body ?? {},
        config: billingConfig,
        fallbackUnitPrice: mapping.unitPrice,
      });
      return {
        mappingId: mapping.id,
        externalModel: input.model,
        realModel: mapping.realModel,
        inputPrice: mapping.inputPrice,
        outputPrice: mapping.outputPrice,
        cacheInputPrice: mapping.cacheInputPrice,
        cacheWritePrice: mapping.cacheWritePrice,
        unitPrice: resolvedUnitPrice,
        inputTokenUpperBound: input.inputTokenUpperBound,
        pricingUnit: mapping.pricingUnit,
        unitUpperBound,
        reservation,
        coefficient: pickCoefficient(snapshot, {
          modelMappingId: mapping.id,
          pricingGroup: mapping.pricingGroup,
        }),
        billingPolicyFingerprint: policyFingerprint(mapping.billingPolicy),
      };
    });

    return {
      maxOutputTokens: input.maxOutputTokens,
      candidates,
      ...(chain.every((mapping) => mapping.isFree) ? { explicitlyFree: true } : {}),
    };
  };
}
