import type { CashForecastResult } from '@xiaocai/engine';

/** Deterministic EN/中文 template explanations — the always-working fallback. */
export function templateShortage(result: CashForecastResult, lang: 'en' | 'zh'): string {
  const day = result.firstShortageDay;
  if (lang === 'zh') {
    if (day === null) {
      return `未来 30 天内没有预测到现金短缺。最低现金点在第 ${result.minBalanceDay} 天，约为 ¥${(result.minBalanceFen / 100).toLocaleString('zh-CN')}。${result.alertLevel === 'WATCH' ? '现金底位偏薄，建议关注。' : ''}`;
    }
    return `按当前假设，预计第 ${day} 天出现现金短缺（${result.firstShortageDateISO?.slice(0, 10)}），最低现金约 ¥${(result.minBalanceFen / 100).toLocaleString('zh-CN')}。系统已生成融资匹配建议，等待您审批。`;
  }
  if (day === null) {
    return `No cash shortage is projected in the next 30 days. The cash floor is day ${result.minBalanceDay} at about ¥${(result.minBalanceFen / 100).toLocaleString('en-US')}.${result.alertLevel === 'WATCH' ? ' The floor is thin — keep an eye on it.' : ''}`;
  }
  return `Under these assumptions, cash runs short on Day ${day} (${result.firstShortageDateISO?.slice(0, 10)}), with a projected low of ¥${(result.minBalanceFen / 100).toLocaleString('en-US')}. Financing options are ready for your approval.`;
}

export function templateDrivers(top: Array<{ label: { en: string; zh: string }; contributionToFenProfitChange: number }>, lang: 'en' | 'zh'): string {
  const fmt = (fen: number): string => `¥${Math.abs(fen / 100).toLocaleString(lang === 'zh' ? 'zh-CN' : 'en-US')}`;
  const parts = top.slice(0, 3).map((d) =>
    lang === 'zh'
      ? `${d.label.zh}（${d.contributionToFenProfitChange >= 0 ? '贡献' : '拖累'} ${fmt(d.contributionToFenProfitChange)}）`
      : `${d.label.en} (${d.contributionToFenProfitChange >= 0 ? '+' : '−'}${fmt(d.contributionToFenProfitChange)})`
  );
  return lang === 'zh' ? `利润变化主要由：${parts.join('、')}驱动。` : `The profit change is driven mainly by: ${parts.join(', ')}.`;
}

export const TEMPLATES = {
  needsClarification: {
    en: 'I could not map that to a scenario. I answer what-if questions like: "If sales drop 20% and supplier costs rise 10%, when do I run short?" or "What if payouts are 15 days slower?" — or use the sliders in the Survival Simulator.',
    zh: '未能将该问题映射为情景假设。我可以回答这类问题：“如果销售下降20%、供应商成本上升10%，我会什么时候缺钱？”“如果回款慢15天会怎样？”或直接使用生存模拟器的滑块。'
  },
  dataNotScenario: {
    en: 'That looks like a data request, not a what-if scenario — the simulator only projects futures, it never invents numbers. Your actual records are on the Dashboard (GMV, settled cash, obligations), Data Sources, and Audit Log pages. To simulate, try: "If sales drop 20% and supplier costs rise 10%, when do I run short?"',
    zh: '这看起来是在要数据，而不是情景假设——模拟器只推演未来，绝不编造数字。您的真实记录请看仪表盘（GMV、已结算现金、供应商义务）、数据源和审计日志页面。要模拟，请试试：“如果销售下降20%、供应商成本上升10%，我会什么时候缺钱？”'
  },
  llmUnavailable: {
    en: 'AI explanations are currently unavailable — all numbers above still come from the deterministic engine.',
    zh: 'AI 解读暂不可用——以上数字仍全部来自确定性引擎。'
  }
} as const;
