import { cashForecast, trueProfit } from '@xiaocai/engine';
import { getAuthorisedDataMany } from '../services/authorized-data';
import { composeBaseForecastSpec, fetchPendingSettlements } from '../services/forecast-spec';
import { prisma } from '../lib/prisma';

/**
 * Deterministic business snapshot for data-question chat turns. Every value
 * comes from Prisma aggregates or the engine — the LLM that phrases the final
 * answer receives ONLY this JSON, and the number guard (numbers.ts) discards
 * any reply containing a figure absent from it. The chatbot can describe
 * these facts; it can never invent them.
 */
export interface BusinessFacts {
  businessName: string;
  isDemo: boolean;
  windowDays: number;
  revenue30dFen: number;
  realProfit30dFen: number;
  /** yuan forms so the LLM quotes readable currency (¥) instead of raw fen */
  revenue30dYuan: number;
  realProfit30dYuan: number;
  unpaidSupplierYuan: number;
  projectedClosingYuan: number;
  marginPct30d: number | null;
  orders30d: number;
  openingCashFen: number;
  projectedClosingFen: number;
  minBalanceFen: number;
  minBalanceDay: number;
  firstShortageDay: number | null;
  alertLevel: string;
  unpaidSupplierFen: number;
  pendingApprovals: number;
  grantedSources: number;
  totalSources: number;
  latestImportAtISO: string | null;
}

export async function collectBusinessFacts(businessId: string): Promise<BusinessFacts> {
  const now = new Date();
  const current = { from: new Date(now.getTime() - 30 * 86_400_000), to: now };

  const [windows, business, unpaidAgg, approvals, sources, latestImport, settlements] =
    await Promise.all([
      getAuthorisedDataMany(businessId, [current]),
      prisma.business.findUniqueOrThrow({
        where: { id: businessId },
        select: { name: true, isDemo: true, openingCash: true }
      }),
      prisma.supplierInvoice.aggregate({
        where: { businessId, status: { not: 'PAID' } },
        _sum: { amount: true }
      }),
      prisma.approval.count({
        where: { status: 'PENDING', recommendation: { businessId } }
      }),
      prisma.dataSource.findMany({ where: { businessId }, select: { status: true } }),
      prisma.importJob.findFirst({
        where: { businessId },
        orderBy: { createdAt: 'desc' },
        select: { createdAt: true }
      }),
      fetchPendingSettlements(businessId, now)
    ]);

  const data = windows[0]!;
  const profit = trueProfit({ orders: data.orders, adSpend: data.adSpend, products: data.products });
  const spec = composeBaseForecastSpec(now, {
    openingCashFen: business.openingCash,
    data,
    settlements
  });
  const forecast = cashForecast(spec);
  const grantedSources = sources.filter((s) => s.status === 'GRANTED').length;

  return {
    businessName: business.name,
    isDemo: business.isDemo,
    windowDays: 30,
    revenue30dFen: profit.summary.revenue,
    realProfit30dFen: profit.summary.realProfit,
    revenue30dYuan: Math.round(profit.summary.revenue) / 100,
    realProfit30dYuan: Math.round(profit.summary.realProfit) / 100,
    unpaidSupplierYuan: Math.round(unpaidAgg._sum.amount ?? 0) / 100,
    projectedClosingYuan: Math.round(forecast.closingBalanceFen) / 100,
    marginPct30d: profit.summary.marginPct,
    orders30d: profit.meta.ordersIncluded,
    openingCashFen: business.openingCash,
    projectedClosingFen: forecast.closingBalanceFen,
    minBalanceFen: forecast.minBalanceFen,
    minBalanceDay: forecast.minBalanceDay,
    firstShortageDay: forecast.firstShortageDay,
    alertLevel: forecast.alertLevel,
    unpaidSupplierFen: unpaidAgg._sum.amount ?? 0,
    pendingApprovals: approvals,
    grantedSources,
    totalSources: sources.length,
    latestImportAtISO: latestImport ? latestImport.createdAt.toISOString().slice(0, 10) : null
  };
}

/** Plain-language fallback if the LLM reply fails the number guard. */
export function templateFacts(f: BusinessFacts, lang: 'en' | 'zh'): string {
  const yuan = (fen: number): string => `¥${(fen / 100).toLocaleString(lang === 'zh' ? 'zh-CN' : 'en-US')}`;
  const margin = f.marginPct30d === null ? '—' : `${f.marginPct30d}%`;
  if (lang === 'zh') {
    return `近 ${f.windowDays} 天：营收 ${yuan(f.revenue30dFen)}，真实利润 ${yuan(f.realProfit30dFen)}（利润率 ${margin}）。当前现金预警级别为 ${f.alertLevel}，未付供应商发票共 ${yuan(f.unpaidSupplierFen)}，待审批 ${f.pendingApprovals} 项。`;
  }
  return `Last ${f.windowDays} days: revenue ${yuan(f.revenue30dFen)}, real profit ${yuan(f.realProfit30dFen)} (${margin} margin). Cash alert level is ${f.alertLevel}, unpaid supplier invoices total ${yuan(f.unpaidSupplierFen)}, and ${f.pendingApprovals} approvals are pending.`;
}
