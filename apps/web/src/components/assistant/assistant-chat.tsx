'use client';

import { useEffect, useRef, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { MessageCircle, Send, X } from 'lucide-react';
import { api, ApiError } from '@/lib/api';
import { cn } from '@/lib/utils';

/**
 * Floating chatbot, available on every app page. Conversation memory is held
 * here (last N turns) and sent with each request — the API stays stateless.
 * The backend answers from the engine or a facts snapshot under a strict
 * number guard, so the chatbot can talk freely without inventing figures.
 */

interface ChatMsg {
  role: 'user' | 'assistant';
  content: string;
}

interface ChatResponse {
  status: string;
  intent?: 'scenario' | 'data' | 'help';
  answer: string;
  params?: { salesChangePct: number; supplierCostChangePct: number; settlementDelayDays: number; adSpendChangePct: number } | null;
  answerSource?: 'guarded' | 'template';
  disclaimer?: string;
}

const HISTORY_LIMIT = 12;

export function AssistantChat() {
  const t = useTranslations('chat');
  const locale = useLocale();
  const [open, setOpen] = useState(false);
  const [messages, setMessages] = useState<ChatMsg[]>([]);
  const [input, setInput] = useState('');
  const [pending, setPending] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const lang = locale.startsWith('zh') ? 'zh' as const : 'en' as const;

  // Greet on first open, so the panel never looks dead.
  useEffect(() => {
    if (open && messages.length === 0) {
      setMessages([{ role: 'assistant', content: t('welcome') }]);
    }
  }, [open, messages.length, t]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
  }, [messages, pending]);

  async function send() {
    const question = input.trim();
    if (!question || pending) return;
    setInput('');
    const nextMessages = [...messages, { role: 'user' as const, content: question }];
    setMessages(nextMessages);
    setPending(true);
    try {
      const data = await api<ChatResponse>('/api/assistant/chat', {
        method: 'POST',
        body: JSON.stringify({
          question,
          lang,
          history: nextMessages.slice(0, -1).slice(-HISTORY_LIMIT)
        })
      });
      setMessages((m) => [...m, { role: 'assistant', content: data.answer }]);
    } catch (err) {
      const detail = err instanceof ApiError ? err.message : t('error');
      setMessages((m) => [...m, { role: 'assistant', content: detail }]);
    } finally {
      setPending(false);
    }
  }

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-label={t('title')}
        className={cn(
          'fixed bottom-5 right-5 z-50 flex h-12 w-12 items-center justify-center rounded-full bg-emerald-600 text-white shadow-lg transition hover:bg-emerald-700',
          open && 'rotate-90'
        )}
      >
        {open ? <X className="h-5 w-5" /> : <MessageCircle className="h-5 w-5" />}
      </button>

      {open && (
        <div className="fixed bottom-20 right-5 z-50 flex h-[520px] max-h-[calc(100vh-7rem)] w-[380px] max-w-[calc(100vw-2.5rem)] flex-col overflow-hidden rounded-2xl border bg-card shadow-2xl">
          <div className="flex items-center gap-2 border-b px-4 py-3">
            <span className="flex h-7 w-7 items-center justify-center rounded-full bg-emerald-100 text-sm text-emerald-700">小财</span>
            <div className="min-w-0">
              <p className="truncate text-sm font-semibold">{t('title')}</p>
              <p className="truncate text-xs text-muted-foreground">{t('subtitle')}</p>
            </div>
          </div>

          <div ref={scrollRef} className="flex-1 space-y-3 overflow-y-auto px-4 py-3">
            {messages.map((m, i) => (
              <div
                key={i}
                className={cn(
                  'max-w-[85%] whitespace-pre-wrap rounded-2xl px-3 py-2 text-sm',
                  m.role === 'user'
                    ? 'ml-auto bg-emerald-600 text-white'
                    : 'mr-auto bg-muted text-foreground'
                )}
              >
                {m.content}
              </div>
            ))}
            {pending && (
              <div className="mr-auto w-16 rounded-2xl bg-muted px-3 py-2 text-sm text-muted-foreground">···</div>
            )}
          </div>

          <div className="flex items-end gap-2 border-t p-3">
            <textarea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  void send();
                }
              }}
              rows={1}
              placeholder={t('placeholder')}
              className="max-h-24 flex-1 resize-none rounded-xl border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-emerald-500/40"
            />
            <button
              type="button"
              onClick={() => void send()}
              disabled={pending || input.trim() === ''}
              aria-label={t('send')}
              className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-emerald-600 text-white transition hover:bg-emerald-700 disabled:opacity-40"
            >
              <Send className="h-4 w-4" />
            </button>
          </div>
        </div>
      )}
    </>
  );
}
