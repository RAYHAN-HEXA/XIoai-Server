import { Router } from 'express';
import { profitDrivers, trueProfit, cashForecast, dailyBriefData, type LocalizedText } from '@xiaocai/engine';
import { filterToRange, getAuthorisedDataMany } from '../services/authorized-data';
import { composeBaseForecastSpec, fetchPendingSettlements } from '../services/forecast-spec';
import { prisma } from '../lib/prisma';
import { requireAuth } from '../middleware/auth';
import { writeAudit } from '../audit/audit';
import { asyncHandler } from '../lib/async';

export const dashboardRouter = Router();

/**
 * One composed read for the dashboard. Everything is authorized, engine-derived
 * and demo-flagged; the page never fabricates a zero for missing data —
 * each field carries its own completeness information.
 */

interface Insight {
  id: string;
  severity: 'info' | 'warning' | 'critical' | 'positive';
  title: LocalizedText;
  detail: LocalizedText;
}

const fmtYuan = (fen: number): string => {
  const v = fen / 100;
  return Math.abs(v) >= 10000 ? `¥${Math.round(v).toLocaleString('en-US')}` : `¥${v.toFixed(2)}`;
};

dashboardRouter.get(
  '/summary',
  requireAuth,
  asyncHandler(async (req, res) => {
    const user = req.user!;
    const now = new Date();
    const current = { from: new Date(now.getTime() - 30 * 86_400_000), to: now };
    const previous = {
      from: new Date(current.from.getTime() - 30 * 86_400_000),
      to: new Date(current.from.getTime() - 1)
    };

    const [windows, business, pendingApprovals, missingDocs, sources, recentImports, settledAgg, obligationsAgg, settlements] =
      await Promise.all([
        getAuthorisedDataMany(user.businessId, [current, previous]),
        prisma.business.findUniqueOrThrow({ where: { id: user.businessId }, select: { name: true, nameZh: true, isDemo: true, openingCash: true, currency: true } }),
        prisma.approval.count({ where: { status: 'PENDING', recommendation: { businessId: user.businessId } } }),
        prisma.supplierInvoice.count({ where: { businessId: user.businessId, status: 'MISSING_DOC' } }),
        prisma.dataSource.findMany({ where: { businessId: user.businessId }, select: { id: true, status: true, grantedAt: true, revokedAt: true } }),
        prisma.importJob.findMany({ where: { businessId: user.businessId }, orderBy: { createdAt: 'desc' }, take: 3 }),
        prisma.settlement.aggregate({
          where: { businessId: user.businessId, status: 'RECEIVED' },
          _sum: { amount: true }
        }),
        prisma.supplierInvoice.aggregate({
          where: { businessId: user.businessId, status: { not: 'PAID' } },
          _sum: { amount: true }
        }),
        fetchPendingSettlements(user.businessId, now)
      ]);

    // getAuthorisedDataMany returns exactly one row per requested range
    const cur = windows[0]!;
    const prev = windows[1]!;
    // spec runs on the same 30-day window as `cur`; brief on a 14-day slice of it.
    const spec = composeBaseForecastSpec(now, {
      openingCashFen: business.openingCash,
      data: cur,
      settlements
    });
    const briefInput = filterToRange(cur, { from: new Date(now.getTime() - 14 * 86_400_000), to: now });

    const summary = trueProfit({ orders: cur.orders, adSpend: cur.adSpend, products: cur.products });
    const drivers = profitDrivers(
      { orders: cur.orders, adSpend: cur.adSpend, products: cur.products },
      { orders: prev.orders, adSpend: prev.adSpend, products: prev.products }
    );
    const forecast = cashForecast(spec);
    const brief = dailyBriefData({
      asOfISO: now.toISOString(),
      supplierInvoices: briefInput.supplierInvoices,
      orders: briefInput.orders,
      adSpend: briefInput.adSpend,
      products: briefInput.products,
      forecastSpec: spec,
      approvalsPending: []
    });

    // money actually received (all-time settled payouts) vs GMV vs obligations
    const settledFen = settledAgg._sum.amount ?? 0;
    const obligationsFen = obligationsAgg._sum.amount ?? 0;

    const lastOrderAt = cur.orders.reduce<Date | null>((max, o) => {
      const d = new Date(o.orderedAt);
      return !max || d > max ? d : max;
    }, null);

    // ── top-3 evidence-backed insights (deterministic templates, engine numbers) ──
    const insights: Insight[] = [];

    const topDriver = drivers.drivers[0];
    if (topDriver) {
      const dir = drivers.profitChangeFen > 0 ? 'positive' : drivers.profitChangeFen < 0 ? 'warning' : 'info';
      const pct =
        drivers.profitChangePct !== null
          ? `${drivers.profitChangePct > 0 ? '+' : ''}${drivers.profitChangePct}%`
          : fmtYuan(drivers.profitChangeFen);
      insights.push({
        id: 'profit-change',
        severity: dir,
        title: {
          en: `Real profit ${drivers.profitChangeFen >= 0 ? 'up' : 'down'} ${pct} vs the previous 30 days`,
          zh: `真实利润较上一个 30 天${drivers.profitChangeFen >= 0 ? '上升' : '下降'} ${pct}`
        },
        detail: {
          en: `${topDriver.label.en} explains most of the change (${fmtYuan(topDriver.contributionToFenProfitChange)}). Tap any figure for its evidence.`,
          zh: `${topDriver.label.zh} 是变化的主因（${fmtYuan(topDriver.contributionToFenProfitChange)}）。点击任意数字可查看证据链。`
        }
      });
    }

    if (forecast.firstShortageDay !== null) {
      insights.push({
        id: 'cash-shortage',
        severity: 'critical',
        title: {
          en: `Cash runs short on day ${forecast.firstShortageDay} in the base forecast`,
          zh: `基础预测下第 ${forecast.firstShortageDay} 天现金出现短缺`
        },
        detail: {
          en: `Minimum balance ${fmtYuan(forecast.minBalanceFen)}. Open the Survival Simulator to test counter-measures.`,
          zh: `最低余额 ${fmtYuan(forecast.minBalanceFen)}。请打开生存模拟器测试应对方案。`
        }
      });
    } else {
      const urgent = brief.urgentPayments[0];
      if (urgent) {
        insights.push({
          id: 'urgent-payment',
          severity: urgent.urgency === 'OVERDUE' ? 'critical' : 'warning',
          title: {
            en: `${urgent.label} payment ${urgent.urgency === 'OVERDUE' ? 'is overdue' : `due ${urgent.dueDate.slice(0, 10)}`}`,
            zh: `${urgent.label} 付款${urgent.urgency === 'OVERDUE' ? '已逾期' : `将于 ${urgent.dueDate.slice(0, 10)} 到期`}`
          },
          detail: {
            en: `${fmtYuan(urgent.amountFen)} — the base forecast still holds (no shortage within 30 days).`,
            zh: `${fmtYuan(urgent.amountFen)}——基础预测仍然安全（30 天内无短缺）。`
          }
        });
      } else {
        insights.push({
          id: 'cash-ok',
          severity: 'positive',
          title: { en: 'No cash shortage projected in the next 30 days', zh: '未来 30 天未预测到现金短缺' },
          detail: {
            en: `Minimum projected balance ${fmtYuan(forecast.minBalanceFen)} on day ${forecast.minBalanceDay}.`,
            zh: `预测最低余额 ${fmtYuan(forecast.minBalanceFen)}，出现在第 ${forecast.minBalanceDay} 天。`
          }
        });
      }
    }

    const rising = brief.risingCosts[0];
    if (rising) {
      insights.push({
        id: 'rising-cost',
        severity: 'warning',
        title: {
          en: `${rising.category.en} rose ${rising.changePct !== null ? `${rising.changePct}%` : fmtYuan(rising.changeFen)} week over week`,
          zh: `${rising.category.zh} 周环比上升 ${rising.changePct !== null ? `${rising.changePct}%` : fmtYuan(rising.changeFen)}`
        },
        detail: {
          en: `${fmtYuan(rising.previousFen)} → ${fmtYuan(rising.currentFen)} over the last 7 days.`,
          zh: `近 7 天从 ${fmtYuan(rising.previousFen)} 升至 ${fmtYuan(rising.currentFen)}。`
        }
      });
    }

    writeAudit({
      businessId: user.businessId,
      userId: user.id,
      action: 'DATA_ACCESS',
      entityType: 'FINANCIAL',
      ip: req.ip,
      metadata: { endpoint: 'GET /api/dashboard/summary' }
    });

    res.json({
      business,
      range: { from: current.from.toISOString(), to: current.to.toISOString() },
      revenue: summary.summary.revenue,
      realProfit: summary.summary.realProfit,
      marginPct: summary.summary.marginPct,
      gmv30Fen: summary.summary.revenue,
      settledFen,
      obligationsFen,
      cash: {
        openingCashFen: forecast.openingCashFen,
        alertLevel: forecast.alertLevel,
        firstShortageDay: forecast.firstShortageDay,
        firstShortageDateISO: forecast.firstShortageDateISO,
        minBalanceFen: forecast.minBalanceFen,
        minBalanceDay: forecast.minBalanceDay
      },
      counts: {
        pendingApprovals,
        missingDocs,
        sourcesGranted: sources.filter((s) => s.status === 'GRANTED').length,
        sourcesRevoked: sources.filter((s) => s.status === 'REVOKED').length,
        ordersIncluded: summary.meta.ordersIncluded
      },
      insights: insights.slice(0, 3),
      recentImports,
      freshness: {
        lastOrderAt: lastOrderAt?.toISOString() ?? null,
        lastImportAt: recentImports[0]?.createdAt.toISOString() ?? null,
        computedAt: now.toISOString()
      },
      revokedSourceCount: cur.revokedSourceCount
    });
  })
);
