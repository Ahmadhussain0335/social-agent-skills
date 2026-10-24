import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadState, verifyCheckpoint } from '../../shared/approval';
import { PlatformError } from '../../shared/errors';
import { type GraphClient, GraphError } from '../meta/graph';
import { type Contact, maskPhone } from './contacts';
import type { Category } from './pricing';
import { listTemplates } from './templates';

// A broadcast folder holds broadcast.json, contacts.csv, state.json and results.jsonl.
// The "send" approval covers broadcast.json and contacts.csv. results.jsonl makes sending
// resumable: contacts already sent are skipped, so a rerun never double-sends.

export const BROADCAST_FILES = {
  config: 'broadcast.json',
  contacts: 'contacts.csv',
  results: 'results.jsonl',
} as const;
export const SEND_CHECKPOINT = { id: 'send', title: 'Send this broadcast to these contacts', requires: [] };

export interface BroadcastConfig {
  template: { name: string; language: string; category: Category };
  /** Body parameters in order; "{column}" is replaced with that contacts.csv column. */
  bodyParams?: string[];
  /** Messages per second; kept well under Meta's 80/s default. */
  ratePerSecond?: number;
}

export interface SendResult {
  phone: string;
  status: 'sent' | 'skipped' | 'failed';
  messageId?: string;
  code?: number;
  reason?: string;
  at: string;
}

// Errors that mean the whole run must stop, not just this recipient.
const FATAL = new Set([0, 4, 10, 190, 200, 368, 80007, 131031, 131042, 131048, 132001, 132007, 132015, 132016, 133010]);
// Per-recipient outcomes that must not be retried.
const SKIP = new Map<number, string>([
  [131026, 'undeliverable'],
  [131049, 'marketing limit for this user'],
  [131050, 'opted out of marketing'],
]);

export function fillParams(params: readonly string[], row: Record<string, string>): string[] {
  return params.map((p) =>
    p.replace(/\{(\w+)\}/g, (_, column: string) => {
      const value = row[column.toLowerCase()];
      if (value === undefined || value === '') {
        throw new PlatformError('WA_PARAM_MISSING', `contacts.csv has no value for column "${column}"`);
      }
      return value;
    }),
  );
}

export function templatePayload(config: BroadcastConfig, contact: Contact): Record<string, unknown> {
  const params = fillParams(config.bodyParams ?? [], contact.row);
  return {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to: contact.phone,
    type: 'template',
    template: {
      name: config.template.name,
      language: { code: config.template.language },
      ...(params.length > 0
        ? { components: [{ type: 'body', parameters: params.map((text) => ({ type: 'text', text })) }] }
        : {}),
    },
  };
}

export function readResults(dir: string): Map<string, SendResult> {
  const path = join(dir, BROADCAST_FILES.results);
  const results = new Map<string, SendResult>();
  if (!existsSync(path)) return results;
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    const result = JSON.parse(line) as SendResult;
    results.set(result.phone, result);
  }
  return results;
}

export async function requireSendApproval(dir: string): Promise<void> {
  const result = await verifyCheckpoint(dir, loadState(dir), SEND_CHECKPOINT.id, [
    BROADCAST_FILES.config,
    BROADCAST_FILES.contacts,
  ]);
  if (!result.ok) {
    throw new PlatformError(
      'APPROVAL_REQUIRED',
      `Broadcast is not approved: ${result.problems.join('; ')}`,
      'Show the user the plan (recipients, exclusions, cost estimate), then ask them to run the broadcast approve command in their own terminal.',
    );
  }
}

export async function requireApprovedTemplate(
  client: GraphClient,
  wabaId: string,
  config: BroadcastConfig,
): Promise<void> {
  const match = (await listTemplates(client, wabaId, config.template.name)).find(
    (t) => t.name === config.template.name && t.language === config.template.language,
  );
  if (!match) {
    throw new PlatformError(
      'WA_TEMPLATE_NOT_FOUND',
      `Template ${config.template.name} (${config.template.language}) not found.`,
    );
  }
  if (match.status !== 'APPROVED') {
    throw new PlatformError('WA_TEMPLATE_NOT_APPROVED', `Template ${match.name} is ${match.status}, not APPROVED.`);
  }
  if (match.category !== config.template.category) {
    throw new PlatformError(
      'WA_TEMPLATE_CATEGORY',
      `Template ${match.name} is ${match.category} at Meta but broadcast.json says ${config.template.category}.`,
      'Meta may re-categorise templates (e.g. utility to marketing). Update broadcast.json, re-run the plan so the cost estimate is right, and get a new approval.',
    );
  }
}

export interface SendOptions {
  dir: string;
  client: GraphClient;
  phoneNumberId: string;
  config: BroadcastConfig;
  contacts: readonly Contact[];
  sleep?: (ms: number) => Promise<void>;
  onResult?: (result: SendResult) => void;
}

export async function sendBroadcast(
  opts: SendOptions,
): Promise<{ sent: number; skipped: number; failed: number; stoppedBy?: string }> {
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const interval = 1000 / Math.min(Math.max(opts.config.ratePerSecond ?? 10, 1), 50);
  const done = readResults(opts.dir);
  const counts = { sent: 0, skipped: 0, failed: 0 };
  const record = (result: SendResult) => {
    appendFileSync(join(opts.dir, BROADCAST_FILES.results), `${JSON.stringify(result)}\n`);
    counts[result.status]++;
    opts.onResult?.(result);
  };

  for (const contact of opts.contacts) {
    const previous = done.get(contact.phone);
    if (previous && previous.status !== 'failed') continue;

    let attempt = 0;
    for (;;) {
      try {
        const res = (await opts.client.post(`${opts.phoneNumberId}/messages`, {
          ...flatten(templatePayload(opts.config, contact)),
        })) as { messages?: Array<{ id: string }> };
        record({
          phone: contact.phone,
          status: 'sent',
          messageId: res.messages?.[0]?.id,
          at: new Date().toISOString(),
        });
        break;
      } catch (error) {
        const code = error instanceof GraphError ? error.graph.code : undefined;
        if (code === 130429 && attempt < 5) {
          await sleep(2 ** attempt * 1000);
          attempt++;
          continue;
        }
        if (code !== undefined && SKIP.has(code)) {
          record({
            phone: contact.phone,
            status: 'skipped',
            code,
            reason: SKIP.get(code),
            at: new Date().toISOString(),
          });
          break;
        }
        const reason = error instanceof Error ? error.message : String(error);
        record({ phone: contact.phone, status: 'failed', code, reason, at: new Date().toISOString() });
        if (code === undefined || FATAL.has(code)) {
          return { ...counts, stoppedBy: `${code ?? 'error'} on ${maskPhone(contact.phone)}: ${reason}` };
        }
        break;
      }
    }
    await sleep(interval);
  }
  return counts;
}

/** The Graph client sends form fields; nested message objects go as JSON strings. */
function flatten(payload: Record<string, unknown>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(payload).map(([k, v]) => [k, typeof v === 'object' ? JSON.stringify(v) : String(v)]),
  );
}
