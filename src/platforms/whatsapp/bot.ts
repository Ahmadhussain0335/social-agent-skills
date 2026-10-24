import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PlatformError } from '../../shared/errors';
import { parseCsv } from './contacts';

// Business-scoped support bot. It answers only from a knowledge base the business wrote and
// approved; there is no language model and no open-ended conversation. Anything it cannot
// match is handed to a person. This keeps the bot inside Meta's WhatsApp Business terms
// (section 4.7, effective 2026-01-15), which prohibit general-purpose AI assistants.

export const KB_FILE = 'support-kb.json';
export const GO_LIVE_CHECKPOINT = {
  id: 'go-live',
  title: 'Let the bot answer customers with these replies',
  requires: [],
};

export interface KnowledgeBase {
  business: { name: string; handoffMessage: string; greeting?: string };
  faqs: Array<{ id: string; keywords: string[]; answer: string }>;
  orders?: {
    /** CSV exported from the order system, relative to the bot folder. Not covered by approval. */
    file: string;
    idPattern: string;
    idColumn: string;
    statusColumn: string;
    /** Reply template with {id} and {status}. */
    reply: string;
  };
  optOutKeywords?: string[];
  optOutReply?: string;
}

export type BotDecision =
  | { kind: 'faq'; id: string; text: string }
  | { kind: 'order'; id: string; text: string }
  | { kind: 'opt_out'; text: string }
  | { kind: 'opt_in'; text: string }
  | { kind: 'handoff'; text: string };

const DEFAULT_OPT_OUT = ['stop', 'unsubscribe', 'opt out', 'optout'];

export function checkKnowledgeBase(raw: unknown): string[] {
  const kb = (raw ?? {}) as Partial<KnowledgeBase>;
  const errors: string[] = [];
  if (!kb.business?.name) errors.push('business.name is required');
  if (!kb.business?.handoffMessage)
    errors.push('business.handoffMessage is required (what customers see when a person takes over)');
  if (!Array.isArray(kb.faqs) || kb.faqs.length === 0) errors.push('faqs must contain at least one entry');
  const ids = new Set<string>();
  for (const [i, faq] of (kb.faqs ?? []).entries()) {
    if (!faq.id || ids.has(faq.id)) errors.push(`faqs[${i}].id must be unique`);
    ids.add(faq.id);
    if (!Array.isArray(faq.keywords) || faq.keywords.length === 0) errors.push(`faqs[${i}] needs keywords`);
    if (!faq.answer?.trim()) errors.push(`faqs[${i}] needs an answer`);
    if ((faq.answer ?? '').length > 4096) errors.push(`faqs[${i}].answer exceeds 4096 characters`);
  }
  if (kb.orders) {
    try {
      new RegExp(kb.orders.idPattern);
    } catch {
      errors.push('orders.idPattern is not a valid regular expression');
    }
    if (!kb.orders.reply?.includes('{status}')) errors.push('orders.reply must contain {status}');
  }
  return errors;
}

function normalise(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Picks the FAQ with the most keyword hits; ties go to the earlier entry. */
export function decide(
  kb: KnowledgeBase,
  message: string,
  lookupOrder?: (id: string) => string | undefined,
): BotDecision {
  const text = normalise(message);
  const words = new Set(text.split(' '));

  const optOut = (kb.optOutKeywords ?? DEFAULT_OPT_OUT).map(normalise);
  if (optOut.includes(text)) {
    return {
      kind: 'opt_out',
      text:
        kb.optOutReply ??
        `You have been unsubscribed from ${kb.business.name} messages. Reply START to subscribe again.`,
    };
  }

  if (text === 'start') {
    return {
      kind: 'opt_in',
      text: `You are subscribed to ${kb.business.name} messages again. Reply STOP to unsubscribe.`,
    };
  }

  if (kb.orders && lookupOrder) {
    const match = new RegExp(kb.orders.idPattern, 'i').exec(message);
    if (match) {
      const id = match[0];
      const status = lookupOrder(id);
      if (status) return { kind: 'order', id, text: kb.orders.reply.replace('{id}', id).replace('{status}', status) };
    }
  }

  let best: { faq: KnowledgeBase['faqs'][number]; score: number } | undefined;
  for (const faq of kb.faqs) {
    const score = faq.keywords.reduce((sum, keyword) => {
      const k = normalise(keyword);
      return sum + (k.includes(' ') ? (text.includes(k) ? 2 : 0) : words.has(k) ? 1 : 0);
    }, 0);
    if (score > 0 && (!best || score > best.score)) best = { faq, score };
  }
  if (best) return { kind: 'faq', id: best.faq.id, text: best.faq.answer };
  return { kind: 'handoff', text: kb.business.handoffMessage };
}

export function orderLookup(dir: string, kb: KnowledgeBase): ((id: string) => string | undefined) | undefined {
  if (!kb.orders) return undefined;
  const path = join(dir, kb.orders.file);
  if (!existsSync(path)) throw new PlatformError('WA_ORDERS_MISSING', `Orders file not found: ${kb.orders.file}`);
  const { idColumn, statusColumn } = kb.orders;
  return (id) => {
    // Re-read on each lookup so a fresh export is picked up without restarting the bot.
    const row = parseCsv(readFileSync(path, 'utf8')).find(
      (r) => (r[idColumn.toLowerCase()] ?? '').toLowerCase() === id.toLowerCase(),
    );
    return row?.[statusColumn.toLowerCase()] || undefined;
  };
}
