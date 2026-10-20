import { z } from 'zod';
import { clampScenarioParams } from '@xiaocai/engine';
import type { LlmProvider } from './provider';
import { tryComplete } from './provider';

/**
 * Chat intent router: one LLM call classifies the turn AND, for scenario
 * turns, extracts the parameters. Conversation history lets follow-ups like
 * "what about 30%?" or "now with slower payouts?" carry forward context.
 * Output is STRICT JSON, Zod-validated, then clamped by the engine — the
 * model can only choose among intents and numbers the app understands.
 */

export type ChatIntent = 'scenario' | 'data' | 'help';

export interface ChatTurn {
  role: 'user' | 'assistant';
  content: string;
}

export interface ChatIntentResult {
  intent: ChatIntent;
  ok: boolean;
  unavailable?: boolean;
  needsClarification?: boolean;
  confidence?: number;
  params?: { salesChangePct: number; supplierCostChangePct: number; settlementDelayDays: number; adSpendChangePct: number };
}

const rawSchema = z.object({
  intent: z.enum(['scenario', 'data', 'help']).default('scenario'),
  confidence: z.number().min(0).max(1),
  salesChangePct: z.number().default(0),
  supplierCostChangePct: z.number().default(0),
  settlementDelayDays: z.number().default(0),
  adSpendChangePct: z.number().default(0)
});

const SYSTEM = `You are the intent router of a small-business finance copilot. The copilot can:
1. SIMULATE what-if scenarios (change sales, supplier costs, payout delays, ad spend → project cash).
2. REPORT actual facts about this business (profit, revenue, cash, obligations, approvals, data sources) — computed by a deterministic engine, never invented.
3. Small talk / capability questions.

Answer with STRICT JSON ONLY — no prose, no markdown, no code fences.
Schema:
{"intent": "scenario" | "data" | "help", "confidence": number, "salesChangePct": number, "supplierCostChangePct": number, "settlementDelayDays": number, "adSpendChangePct": number}

Rules:
- intent "scenario": the user asks what happens if inputs change (what-if, "if sales drop 20%", hypotheticals). Extract the mentioned percentages/days as WHOLE numbers (-20 for "drop 20%"). Unmentioned values are 0, EXCEPT when earlier conversation turns already established them — carry those forward.
- intent "data": the user asks about actual/current state — profit, revenue, cash, GMV, obligations, unpaid invoices, approvals, sources, imports, "how is my business".
- intent "help": greetings, thanks, capability questions, or anything that is neither a usable scenario nor a data question. Then set confidence to 0.
- Questions may be in English or 简体中文. confidence is 0..1 for how sure you are about the intent and the extracted numbers.`;

function extractJson(text: string): unknown {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end <= start) return null;
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
}

function renderHistory(history: ChatTurn[]): string {
  if (history.length === 0) return '(no earlier turns)';
  return history
    .slice(-8)
    .map((t) => `${t.role === 'user' ? 'User' : 'Assistant'}: ${t.content.slice(0, 300)}`)
    .join('\n');
}

export async function routeChatTurn(
  provider: LlmProvider,
  question: string,
  history: ChatTurn[]
): Promise<ChatIntentResult> {
  if (provider.name === 'noop') {
    return { intent: 'help', ok: false, unavailable: true };
  }
  const text = await tryComplete(provider, {
    system: SYSTEM,
    user: `Conversation so far:\n${renderHistory(history)}\n\nNew user message: ${question}`,
    maxTokens: 256
  });
  if (text === null || text.trim() === '') {
    return { intent: 'help', ok: false, unavailable: true };
  }
  const parsed = rawSchema.safeParse(extractJson(text));
  if (!parsed.success) {
    return { intent: 'scenario', ok: false, needsClarification: true };
  }
  const { intent, confidence, ...raw } = parsed.data;
  if (intent === 'scenario' && confidence < 0.5) {
    return { intent, ok: false, needsClarification: true, confidence };
  }
  if (intent !== 'scenario') {
    return { intent, ok: true, confidence };
  }
  return { intent, ok: true, params: clampScenarioParams(raw), confidence };
}
