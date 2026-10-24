import { readFileSync } from 'node:fs';
import { PlatformError } from '../../shared/errors';

// Contacts come from a CSV the business exports from its own opt-in records.
// Required columns: phone, opt_in_at. Optional: name, opt_in_source, opted_out_at,
// plus any columns referenced by template parameters.

export interface Contact {
  phone: string;
  row: Record<string, string>;
}

export type ExclusionReason = 'invalid_phone' | 'no_opt_in' | 'opted_out' | 'duplicate' | 'us_marketing';

export interface ContactSelection {
  eligible: Contact[];
  excluded: Array<{ phone: string; reason: ExclusionReason }>;
}

/** Minimal RFC 4180 parser: quoted fields, escaped quotes, CRLF. */
export function parseCsv(text: string): Record<string, string>[] {
  const rows: string[][] = [];
  let field = '';
  let row: string[] = [];
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (ch === '"') {
        quoted = false;
      } else {
        field += ch;
      }
    } else if (ch === '"') {
      quoted = true;
    } else if (ch === ',') {
      row.push(field);
      field = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else {
      field += ch;
    }
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  const [header, ...body] = rows.filter((r) => r.some((cell) => cell.trim().length > 0));
  if (!header) return [];
  const keys = header.map((h) => h.trim().toLowerCase());
  return body.map((cells) => Object.fromEntries(keys.map((key, i) => [key, (cells[i] ?? '').trim()])));
}

/** WhatsApp expects digits with country code and no plus sign. */
export function normalizePhone(raw: string): string | undefined {
  let digits = raw.replace(/[\s().-]/g, '');
  if (digits.startsWith('+')) digits = digits.slice(1);
  else if (digits.startsWith('00')) digits = digits.slice(2);
  return /^[1-9]\d{7,14}$/.test(digits) ? digits : undefined;
}

export function readContacts(path: string): Record<string, string>[] {
  const rows = parseCsv(readFileSync(path, 'utf8'));
  const first = rows[0];
  if (!first || !('phone' in first) || !('opt_in_at' in first)) {
    throw new PlatformError(
      'WA_CONTACTS_FORMAT',
      'contacts.csv must have a header row with at least "phone" and "opt_in_at" columns.',
      'Export contacts from the system where you recorded their opt-in, with the opt-in date per contact.',
    );
  }
  return rows;
}

export interface SelectOptions {
  /** Phones that opted out through the support bot or a previous broadcast. */
  optedOut?: ReadonlySet<string>;
  category: 'MARKETING' | 'UTILITY' | 'AUTHENTICATION';
}

/** Applies opt-in, opt-out and dedupe rules. Never returns a contact without a recorded opt-in. */
export function selectContacts(rows: Record<string, string>[], opts: SelectOptions): ContactSelection {
  const eligible: Contact[] = [];
  const excluded: ContactSelection['excluded'] = [];
  const seen = new Set<string>();

  for (const row of rows) {
    const phone = normalizePhone(row.phone ?? '');
    if (!phone) {
      excluded.push({ phone: row.phone ?? '', reason: 'invalid_phone' });
      continue;
    }
    if (seen.has(phone)) {
      excluded.push({ phone, reason: 'duplicate' });
      continue;
    }
    seen.add(phone);
    if (!row.opt_in_at || Number.isNaN(Date.parse(row.opt_in_at))) {
      excluded.push({ phone, reason: 'no_opt_in' });
    } else if (row.opted_out_at || opts.optedOut?.has(phone)) {
      excluded.push({ phone, reason: 'opted_out' });
    } else if (opts.category === 'MARKETING' && isUsNumber(phone)) {
      // WhatsApp does not currently deliver marketing templates to US numbers.
      excluded.push({ phone, reason: 'us_marketing' });
    } else {
      eligible.push({ phone, row });
    }
  }
  return { eligible, excluded };
}

// +1 is shared by the US, Canada and Caribbean countries. Canadian area codes are listed so
// Canada still receives marketing; every other +1 number is treated as US, erring towards not sending.
const NON_US_NANP = new Set([
  '204',
  '226',
  '236',
  '249',
  '250',
  '263',
  '289',
  '306',
  '343',
  '354',
  '365',
  '367',
  '368',
  '382',
  '403',
  '416',
  '418',
  '428',
  '431',
  '437',
  '438',
  '450',
  '468',
  '474',
  '506',
  '514',
  '519',
  '548',
  '579',
  '581',
  '584',
  '587',
  '604',
  '613',
  '639',
  '647',
  '672',
  '683',
  '705',
  '709',
  '742',
  '753',
  '778',
  '780',
  '782',
  '807',
  '819',
  '825',
  '867',
  '873',
  '879',
  '902',
  '905',
]);

export function isUsNumber(phone: string): boolean {
  return phone.length === 11 && phone.startsWith('1') && !NON_US_NANP.has(phone.slice(1, 4));
}

export function maskPhone(phone: string): string {
  return phone.length > 6 ? `${phone.slice(0, 4)}${'*'.repeat(phone.length - 6)}${phone.slice(-2)}` : '****';
}
