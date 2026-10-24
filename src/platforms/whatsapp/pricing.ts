import { existsSync, readFileSync } from 'node:fs';
import { PlatformError } from '../../shared/errors';
import type { Contact } from './contacts';

// Meta publishes rates only as a rate card (CSV/PDF and a web page); there is no rates API.
// The user copies the rates they need into rates.json, so the estimate shows its source date.
// https://developers.facebook.com/documentation/business-messaging/whatsapp/pricing

export type Category = 'MARKETING' | 'UTILITY' | 'AUTHENTICATION';

export interface RatesFile {
  currency: string;
  /** Date of the Meta rate card the numbers were copied from. */
  effectiveDate: string;
  /** Keyed by calling-code prefix, e.g. "92", "44", "1"; longest prefix wins. */
  rates: Record<string, Partial<Record<Lowercase<Category>, number>>>;
  /** Used when no prefix matches. */
  default?: Partial<Record<Lowercase<Category>, number>>;
}

export interface CostEstimate {
  currency: string;
  effectiveDate: string;
  category: Category;
  total: number;
  byPrefix: Record<string, { recipients: number; rate: number; subtotal: number }>;
  unpriced: number;
  notes: string[];
}

export function readRates(path: string): RatesFile {
  if (!existsSync(path)) {
    throw new PlatformError(
      'WA_RATES_MISSING',
      `No rates file at ${path}.`,
      'Copy the per-message rates for your recipient countries from the WhatsApp rate card (business.whatsapp.com/products/platform-pricing) into rates.json; see references/pricing.md.',
    );
  }
  const rates = JSON.parse(readFileSync(path, 'utf8')) as RatesFile;
  if (!rates.currency || !rates.effectiveDate || typeof rates.rates !== 'object') {
    throw new PlatformError('WA_RATES_FORMAT', 'rates.json needs currency, effectiveDate and rates.');
  }
  return rates;
}

export function estimateCost(contacts: readonly Contact[], category: Category, rates: RatesFile): CostEstimate {
  const key = category.toLowerCase() as Lowercase<Category>;
  const prefixes = Object.keys(rates.rates).sort((a, b) => b.length - a.length);
  const byPrefix: CostEstimate['byPrefix'] = {};
  let unpriced = 0;

  for (const contact of contacts) {
    const prefix = prefixes.find((p) => contact.phone.startsWith(p));
    const rate = prefix ? rates.rates[prefix]?.[key] : rates.default?.[key];
    if (rate === undefined) {
      unpriced++;
      continue;
    }
    const bucket = prefix ?? 'default';
    const entry = byPrefix[bucket] ?? { recipients: 0, rate, subtotal: 0 };
    byPrefix[bucket] = entry;
    entry.recipients++;
    entry.subtotal = round(entry.subtotal + rate);
  }

  const total = round(Object.values(byPrefix).reduce((sum, b) => sum + b.subtotal, 0));
  const notes = [
    'List-price estimate: Meta charges only delivered messages, volume tiers (utility and authentication) and free entry point windows lower the real cost.',
  ];
  if (unpriced > 0)
    notes.push(`${unpriced} recipients have no rate for ${category} in rates.json and are not included in the total.`);
  return { currency: rates.currency, effectiveDate: rates.effectiveDate, category, total, byPrefix, unpriced, notes };
}

function round(n: number): number {
  return Math.round(n * 10_000) / 10_000;
}
