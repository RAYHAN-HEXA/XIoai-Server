import { env } from '../config/env';
import { logger } from '../lib/logger';

/**
 * LLM provider abstraction — the AI layer is OPTIONAL.
 * With no GEMINI_API_KEY (or on any provider failure), callers fall back to
 * deterministic templates. The AI NEVER creates numbers: it only parses
 * questions into scenario params and writes explanations over engine JSON that
 * is post-validated number-by-number (see explain.ts).
 *
 * Uses the free-tier Gemini REST API via plain fetch — no SDK dependency.
 */
export interface LlmProvider {
  readonly name: 'gemini' | 'noop';
  complete(req: { system: string; user: string; maxTokens?: number }): Promise<string>;
}

export class NoopProvider implements LlmProvider {
  readonly name = 'noop' as const;
  async complete(_req: { system: string; user: string; maxTokens?: number }): Promise<string> {
    return '';
  }
}

const MODEL = 'gemini-2.5-flash';
const API_BASE = 'https://generativelanguage.googleapis.com/v1beta';

export class GeminiProvider implements LlmProvider {
  readonly name = 'gemini' as const;

  async complete(req: { system: string; user: string; maxTokens?: number }): Promise<string> {
    const res = await fetch(`${API_BASE}/models/${MODEL}:generateContent`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': env.GEMINI_API_KEY ?? ''
      },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: req.system }] },
        contents: [{ role: 'user', parts: [{ text: req.user }] }],
        generationConfig: {
          // Low temperature: scenario extraction and number-guarded explanations
          // both want minimal variance; every number still comes from the engine.
          temperature: 0.2,
          maxOutputTokens: req.maxTokens ?? 1024,
          // 2.5-flash "thinks" by default and burns output tokens on it — this
          // task is structured extraction/explanation, not reasoning-heavy.
          thinkingConfig: { thinkingBudget: 0 }
        }
      }),
      signal: AbortSignal.timeout(30_000)
    });

    if (!res.ok) {
      const detail = (await res.text()).slice(0, 300);
      throw new Error(`Gemini API ${res.status}: ${detail}`);
    }

    const data = (await res.json()) as {
      candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
    };
    const text =
      data.candidates?.[0]?.content?.parts?.map((p) => p.text ?? '').join('') ?? '';
    if (!text.trim()) throw new Error('Gemini returned an empty candidate');
    return text;
  }
}

export function getLlmProvider(): LlmProvider {
  if (env.GEMINI_API_KEY && env.GEMINI_API_KEY.trim() !== '') {
    return new GeminiProvider();
  }
  return new NoopProvider();
}

/** Never let an LLM failure break the request — callers must catch. */
export async function tryComplete(provider: LlmProvider, req: { system: string; user: string; maxTokens?: number }): Promise<string | null> {
  if (provider.name === 'noop') return null;
  try {
    return await provider.complete(req);
  } catch (err) {
    logger.warn({ err, provider: provider.name }, 'LLM call failed — falling back to template');
    return null;
  }
}
