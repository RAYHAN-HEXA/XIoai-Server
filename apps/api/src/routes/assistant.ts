import { Router } from 'express';
import { z } from 'zod';
import { applyScenario, financingMatcher } from '@xiaocai/engine';
import { getLlmProvider } from '../ai/provider';
import { parseWhatIf } from '../ai/parseWhatIf';
import { routeChatTurn, type ChatTurn } from '../ai/chat-intent';
import { collectBusinessFacts, templateFacts } from '../ai/facts';
import { explain } from '../ai/explain';
import { templateShortage, TEMPLATES } from '../ai/templates';
import { buildBaseForecastSpec } from '../services/forecast-spec';
import { requireAuth } from '../middleware/auth';
import { writeAudit } from '../audit/audit';
import { asyncHandler } from '../lib/async';

export const assistantRouter = Router();

const askSchema = z.object({
  question: z.string().trim().min(1).max(500),
  lang: z.enum(['en', 'zh']).default('en')
});

const chatSchema = z.object({
  question: z.string().trim().min(1).max(500),
  lang: z.enum(['en', 'zh']).default('en'),
  // Client-held conversation memory — serverless API stays stateless.
  history: z
    .array(
      z.object({
        role: z.enum(['user', 'assistant']),
        content: z.string().trim().min(1).max(1000)
      })
    )
    .max(12)
    .default([])
});

const CHAT_HELP = {
  en: 'I can help with two things: ① What-if scenarios — ask "If sales drop 20% and supplier costs rise 10%, when do I run short?" and I simulate the next 30 days. ② Your actual numbers — ask "How is my profit this month?", "Do I have a cash problem?", or "What do I owe suppliers?" Every figure I quote is computed by the deterministic engine or read from your records — I never invent numbers.',
  zh: '我可以帮你两件事：① 情景模拟——问“如果销售下降20%、供应商成本上升10%，我会什么时候缺钱？”，我会推演未来30天。② 你的真实数据——问“这个月利润怎么样？”“我的现金有问题吗？”“我还欠供应商多少？”。我引用的每个数字都来自确定性引擎或你的真实记录——我绝不编造数字。'
} as const;

/**
 * Natural-language what-if: "If sales drop 20% and supplier costs rise 10%,
 * when do I run short?" → LLM extracts params (Zod + clamped) → the ENGINE
 * computes → the LLM explains (number-guarded) → financing options attach.
 * With the LLM off, the caller gets a template nudge toward the sliders.
 * CSV/user text never reaches the LLM — only the question field does, and it
 * is treated as untrusted data inside a fixed extraction prompt.
 */
assistantRouter.post(
  '/ask',
  requireAuth,
  asyncHandler(async (req, res) => {
    const user = req.user!;
    const body = askSchema.parse(req.body);
    const lang = body.lang;
    const provider = getLlmProvider();

    writeAudit({
      businessId: user.businessId,
      userId: user.id,
      action: 'ASSISTANT_ASK',
      entityType: 'ASSISTANT',
      ip: req.ip,
      metadata: { lang, questionLength: body.question.length }
    });

    const parsed = await parseWhatIf(provider, body.question);
    if (parsed.unavailable) {
      res.json({ status: 'LLM_UNAVAILABLE', answer: TEMPLATES.llmUnavailable[lang], params: null });
      return;
    }
    if (!parsed.ok || !parsed.params) {
      // If the phrasing asks for existing data rather than a what-if, point at
      // the pages that actually hold records — unless scenario words are also
      // present, in which case the generic clarification examples serve better.
      const asksForData = /\b(give|show|pull|send)\s+me\b|\b(last|latest|history|historical|export|download|report|records?)\b|\bdata\b/i.test(body.question);
      const isScenario = /\b(what if|if |drop|fall|rises?|increase|decrease|simulat)\b|如果|假如|下降|上升|增加|减少|模拟/i.test(body.question);
      const answer = asksForData && !isScenario ? TEMPLATES.dataNotScenario[lang] : TEMPLATES.needsClarification[lang];
      res.json({ status: 'NEEDS_CLARIFICATION', answer, params: null });
      return;
    }

    const spec = await buildBaseForecastSpec(user.businessId);
    const stressed = applyScenario(spec, parsed.params);

    const financing = financingMatcher({
      gapAmountFen: stressed.firstShortageDay !== null ? stressed.minBalanceFen : null,
      firstShortageDay: stressed.firstShortageDay,
      reason: 'SHORT_GAP'
    });

    const engineJson = {
      params: parsed.params,
      firstShortageDay: stressed.firstShortageDay,
      firstShortageDateISO: stressed.firstShortageDateISO,
      minBalanceFen: stressed.minBalanceFen,
      minBalanceDay: stressed.minBalanceDay,
      alertLevel: stressed.alertLevel,
      openingCashFen: stressed.openingCashFen,
      closingBalanceFen: stressed.closingBalanceFen,
      optionsCount: financing.ranked.length
    };
    const { text } = await explain(provider, engineJson, templateShortage(stressed, lang), lang);

    res.json({
      status: 'OK',
      params: parsed.params,
      confidence: parsed.confidence,
      scenario: engineJson,
      answer: text,
      answerSource: 'guarded', // number-checked by explain()
      options: financing.ranked.slice(0, 3),
      disclaimer: financing.disclaimer
    });
  })
);

/**
 * Multi-turn chat entry. Each turn is intent-routed by the LLM:
 *  - "scenario": identical guardrail path as /ask (engine computes, LLM explains)
 *  - "data": deterministic business snapshot → LLM phrases it under a strict
 *    number guard that discards any reply containing figures absent from the
 *    snapshot
 *  - "help": canned capability description (no LLM, no numbers)
 * Conversation memory is client-held and passed back each turn — the API
 * stays stateless and nothing chats into the audit log beyond intent metadata.
 */
assistantRouter.post(
  '/chat',
  requireAuth,
  asyncHandler(async (req, res) => {
    const user = req.user!;
    const body = chatSchema.parse(req.body);
    const lang = body.lang;
    const history: ChatTurn[] = body.history;
    const provider = getLlmProvider();

    writeAudit({
      businessId: user.businessId,
      userId: user.id,
      action: 'ASSISTANT_CHAT',
      entityType: 'ASSISTANT',
      ip: req.ip,
      metadata: { lang, questionLength: body.question.length, historyTurns: history.length }
    });

    const routed = await routeChatTurn(provider, body.question, history);

    if (routed.unavailable) {
      res.json({ status: 'LLM_UNAVAILABLE', intent: 'help', answer: TEMPLATES.llmUnavailable[lang], params: null });
      return;
    }

    // ── scenario: engine computes, LLM explains under the number guard ──
    if (routed.intent === 'scenario' && routed.ok && routed.params) {
      const spec = await buildBaseForecastSpec(user.businessId);
      const stressed = applyScenario(spec, routed.params);
      const financing = financingMatcher({
        gapAmountFen: stressed.firstShortageDay !== null ? stressed.minBalanceFen : null,
        firstShortageDay: stressed.firstShortageDay,
        reason: 'SHORT_GAP'
      });
      const engineJson = {
        params: routed.params,
        firstShortageDay: stressed.firstShortageDay,
        firstShortageDateISO: stressed.firstShortageDateISO,
        minBalanceFen: stressed.minBalanceFen,
        minBalanceDay: stressed.minBalanceDay,
        alertLevel: stressed.alertLevel,
        openingCashFen: stressed.openingCashFen,
        closingBalanceFen: stressed.closingBalanceFen,
        optionsCount: financing.ranked.length
      };
      const { text, source } = await explain(provider, engineJson, templateShortage(stressed, lang), lang);
      res.json({
        status: 'OK',
        intent: 'scenario',
        params: routed.params,
        confidence: routed.confidence,
        scenario: engineJson,
        answer: text,
        answerSource: source === 'llm' ? 'guarded' : 'template',
        options: financing.ranked.slice(0, 3),
        disclaimer: financing.disclaimer
      });
      return;
    }

    // ── data: facts snapshot → guarded explanation ──
    if (routed.intent === 'data' && routed.ok) {
      const facts = await collectBusinessFacts(user.businessId);
      const { text, source } = await explain(provider, facts, templateFacts(facts, lang), lang);
      res.json({
        status: 'OK',
        intent: 'data',
        answer: text,
        answerSource: source === 'llm' ? 'guarded' : 'template',
        params: null,
        disclaimer: facts.isDemo
          ? 'Illustrative demo data — this is an isolated sandbox, not your real business.'
          : undefined
      });
      return;
    }

    // ── help: canned, no LLM, no numbers ──
    if (routed.intent === 'help' && routed.ok) {
      res.json({ status: 'OK', intent: 'help', answer: CHAT_HELP[lang], answerSource: 'template', params: null });
      return;
    }

    // ── needs clarification ──
    res.json({ status: 'NEEDS_CLARIFICATION', intent: routed.intent, answer: TEMPLATES.needsClarification[lang], params: null });
  })
);
