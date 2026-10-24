import { createHmac } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { GraphError } from '../src/platforms/meta/graph';
import { checkKnowledgeBase, decide, type KnowledgeBase } from '../src/platforms/whatsapp/bot';
import { fillParams, readResults, sendBroadcast, templatePayload } from '../src/platforms/whatsapp/broadcast';
import { isUsNumber, normalizePhone, parseCsv, selectContacts } from '../src/platforms/whatsapp/contacts';
import { estimateCost, type RatesFile } from '../src/platforms/whatsapp/pricing';
import { ContactStore } from '../src/platforms/whatsapp/store';
import { checkTemplate } from '../src/platforms/whatsapp/templates';
import { createWebhookServer, extractMessages, verifySignature } from '../src/platforms/whatsapp/webhook';
import { tmp } from './helpers';

describe('contacts', () => {
  it('parses quoted CSV fields', () => {
    expect(parseCsv('phone,name,opt_in_at\r\n"+92 300 1234567","Khan, Ali",2026-01-01\n')).toEqual([
      { phone: '+92 300 1234567', name: 'Khan, Ali', opt_in_at: '2026-01-01' },
    ]);
  });

  it('normalises phone numbers to digits with country code', () => {
    expect(normalizePhone('+92 (300) 123-4567')).toBe('923001234567');
    expect(normalizePhone('0092 300 1234567')).toBe('923001234567');
    expect(normalizePhone('0300 1234567')).toBeUndefined();
    expect(normalizePhone('abc')).toBeUndefined();
  });

  it('only selects contacts with a recorded opt-in and no opt-out', () => {
    const rows: Record<string, string>[] = [
      { phone: '+923001111111', opt_in_at: '2026-05-01' },
      { phone: '+923002222222', opt_in_at: '' },
      { phone: '+923003333333', opt_in_at: '2026-05-01', opted_out_at: '2026-06-01' },
      { phone: '+923004444444', opt_in_at: '2026-05-01' },
      { phone: '+923001111111', opt_in_at: '2026-05-01' },
      { phone: 'nope', opt_in_at: '2026-05-01' },
    ];
    const result = selectContacts(rows, { category: 'UTILITY', optedOut: new Set(['923004444444']) });
    expect(result.eligible.map((c) => c.phone)).toEqual(['923001111111']);
    expect(result.excluded.map((e) => e.reason)).toEqual([
      'no_opt_in',
      'opted_out',
      'opted_out',
      'duplicate',
      'invalid_phone',
    ]);
  });

  it('excludes US numbers from marketing but not Canada', () => {
    expect(isUsNumber('12125550100')).toBe(true);
    expect(isUsNumber('14165550100')).toBe(false);
    const rows = [
      { phone: '+12125550100', opt_in_at: '2026-05-01' },
      { phone: '+14165550100', opt_in_at: '2026-05-01' },
    ];
    expect(selectContacts(rows, { category: 'MARKETING' }).eligible.map((c) => c.phone)).toEqual(['14165550100']);
    expect(selectContacts(rows, { category: 'UTILITY' }).eligible).toHaveLength(2);
  });
});

describe('pricing', () => {
  const rates: RatesFile = {
    currency: 'USD',
    effectiveDate: '2026-10-01',
    rates: { '92': { marketing: 0.05, utility: 0.01 }, '44': { marketing: 0.07 } },
  };
  it('estimates by longest calling-code prefix and reports unpriced recipients', () => {
    const contacts = ['923001111111', '923002222222', '447700900000', '4917000000'].map((phone) => ({
      phone,
      row: {},
    }));
    const estimate = estimateCost(contacts, 'MARKETING', rates);
    expect(estimate.total).toBe(0.17);
    expect(estimate.byPrefix['92']).toEqual({ recipients: 2, rate: 0.05, subtotal: 0.1 });
    expect(estimate.unpriced).toBe(1);
    expect(estimate.notes.join(' ')).toMatch(/List-price estimate/);
  });
});

describe('templates', () => {
  const base = {
    name: 'order_update',
    language: 'en_US',
    category: 'UTILITY',
    components: [{ type: 'BODY', text: 'Hi {{1}}, order {{2}} shipped.', example: { body_text: [['A', 'B']] } }],
  };
  it('accepts a valid template', () => {
    expect(checkTemplate(base)).toEqual({ ok: true, errors: [], warnings: [] });
  });
  it('rejects bad names, out-of-order variables and flags promotional utility text', () => {
    const r = checkTemplate({
      ...base,
      name: 'Order-Update',
      components: [{ type: 'BODY', text: 'Hi {{2}}, big sale today {{1}}' }],
    });
    expect(r.errors).toEqual([
      'name must use only lowercase letters, digits and underscores',
      'BODY positional variables must be {{1}}, {{2}}, ... in order',
    ]);
    expect(r.warnings.join(' ')).toMatch(/approve it as MARKETING/);
  });
});

describe('broadcast sending', () => {
  const config = {
    template: { name: 'order_update', language: 'en', category: 'UTILITY' as const },
    bodyParams: ['{name}'],
    ratePerSecond: 50,
  };
  const contacts = ['923001111111', '923002222222', '923003333333'].map((phone, i) => ({
    phone,
    row: { name: `N${i}` },
  }));
  const graphError = (code: number) => new GraphError(400, { code, message: `e${code}` });

  it('builds the template payload with parameters from the contact row', () => {
    expect(templatePayload(config, { phone: '923001111111', row: { name: 'N0' } })).toMatchObject({
      to: '923001111111',
      template: { name: 'order_update', components: [{ type: 'body', parameters: [{ type: 'text', text: 'N0' }] }] },
    });
    expect(() => fillParams(['{missing}'], {})).toThrow(/no value for column "missing"/);
  });

  it('skips per-user errors, retries throughput limits and records results', async () => {
    const dir = tmp();
    const post = vi
      .fn()
      .mockResolvedValueOnce({ messages: [{ id: 'm1' }] })
      .mockRejectedValueOnce(graphError(131050))
      .mockRejectedValueOnce(graphError(130429))
      .mockResolvedValueOnce({ messages: [{ id: 'm3' }] });
    const outcome = await sendBroadcast({
      dir,
      client: { post } as never,
      phoneNumberId: 'P',
      config,
      contacts,
      sleep: async () => {},
    });
    expect(outcome).toEqual({ sent: 2, skipped: 1, failed: 0 });
    expect(readResults(dir).get('923002222222')).toMatchObject({ status: 'skipped', code: 131050 });
  });

  it('never re-sends to contacts already sent on a rerun', async () => {
    const dir = tmp();
    const post = vi.fn().mockResolvedValue({ messages: [{ id: 'x' }] });
    await sendBroadcast({
      dir,
      client: { post } as never,
      phoneNumberId: 'P',
      config,
      contacts,
      sleep: async () => {},
    });
    await sendBroadcast({
      dir,
      client: { post } as never,
      phoneNumberId: 'P',
      config,
      contacts,
      sleep: async () => {},
    });
    expect(post).toHaveBeenCalledTimes(3);
  });

  it('stops the whole run on account-level errors', async () => {
    const dir = tmp();
    const post = vi
      .fn()
      .mockResolvedValueOnce({ messages: [{ id: 'm1' }] })
      .mockRejectedValueOnce(graphError(131042));
    const outcome = await sendBroadcast({
      dir,
      client: { post } as never,
      phoneNumberId: 'P',
      config,
      contacts,
      sleep: async () => {},
    });
    expect(outcome.stoppedBy).toMatch(/^131042/);
    expect(post).toHaveBeenCalledTimes(2);
  });
});

describe('support bot', () => {
  const kb: KnowledgeBase = {
    business: { name: 'Acme', handoffMessage: 'A person will reply soon.' },
    faqs: [
      { id: 'hours', keywords: ['hours', 'open'], answer: 'Open 9-5.' },
      { id: 'delivery', keywords: ['delivery', 'shipping time'], answer: '2-3 days.' },
    ],
    orders: {
      file: 'orders.csv',
      idPattern: 'A-\\d+',
      idColumn: 'id',
      statusColumn: 'status',
      reply: 'Order {id}: {status}',
    },
  };

  it('answers only from the knowledge base and hands off otherwise', () => {
    expect(decide(kb, 'When are you OPEN?')).toMatchObject({ kind: 'faq', id: 'hours' });
    expect(decide(kb, 'what is the shipping time to Lahore')).toMatchObject({ kind: 'faq', id: 'delivery' });
    expect(decide(kb, 'Write me a poem about the sea')).toEqual({ kind: 'handoff', text: 'A person will reply soon.' });
  });

  it('looks up orders and handles opt-out and opt-in keywords', () => {
    expect(
      decide(kb, 'status of a-1042 please', (id) => (id.toUpperCase() === 'A-1042' ? 'shipped' : undefined)),
    ).toEqual({
      kind: 'order',
      id: 'a-1042',
      text: 'Order a-1042: shipped',
    });
    expect(decide(kb, 'STOP').kind).toBe('opt_out');
    expect(decide(kb, 'start').kind).toBe('opt_in');
  });

  it('validates the knowledge base', () => {
    expect(checkKnowledgeBase(kb)).toEqual([]);
    expect(checkKnowledgeBase({ business: { name: 'x' }, faqs: [] })).toHaveLength(2);
  });
});

describe('contact store', () => {
  it('tracks the 24-hour window and expires old entries', () => {
    let now = Date.parse('2026-10-24T10:00:00Z');
    const path = join(tmp(), 'store.json');
    const store = new ContactStore(path, () => now);
    store.recordInbound('923001111111');
    expect(store.windowOpen('923001111111')).toBe(true);
    now += 24 * 60 * 60 * 1000;
    expect(store.windowOpen('923001111111')).toBe(false);
    store.optOut('923002222222');
    expect(new ContactStore(path, () => now).optedOut()).toEqual(new Set(['923002222222']));
  });
});

describe('webhook', () => {
  const secret = 'app-secret';
  const sign = (body: string) => `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
  const payload = JSON.stringify({
    entry: [
      {
        changes: [
          {
            field: 'messages',
            value: {
              messages: [
                {
                  id: 'wamid.1',
                  from: '923001111111',
                  timestamp: '1792800000',
                  type: 'text',
                  text: { body: 'hours?' },
                },
              ],
            },
          },
        ],
      },
    ],
  });

  it('verifies signatures in constant time', () => {
    expect(verifySignature(Buffer.from(payload), sign(payload), secret)).toBe(true);
    expect(verifySignature(Buffer.from(payload), sign('tampered'), secret)).toBe(false);
    expect(verifySignature(Buffer.from(payload), undefined, secret)).toBe(false);
  });

  it('extracts customer messages only', () => {
    expect(extractMessages(JSON.parse(payload))).toEqual([
      { id: 'wamid.1', from: '923001111111', timestamp: 1792800000000, type: 'text', text: 'hours?' },
    ]);
    expect(extractMessages({ entry: [{ changes: [{ field: 'statuses', value: {} }] }] })).toEqual([]);
  });

  it('handles the handshake, rejects unsigned posts and dedupes retries', async () => {
    const onMessage = vi.fn();
    const server = createWebhookServer({ verifyToken: 'vt', appSecret: secret, onMessage });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      const ok = await fetch(`${base}/?hub.mode=subscribe&hub.verify_token=vt&hub.challenge=42`);
      expect([ok.status, await ok.text()]).toEqual([200, '42']);
      expect((await fetch(`${base}/?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=42`)).status).toBe(403);

      expect((await fetch(base, { method: 'POST', body: payload })).status).toBe(401);
      for (let i = 0; i < 2; i++) {
        const res = await fetch(base, {
          method: 'POST',
          body: payload,
          headers: { 'x-hub-signature-256': sign(payload) },
        });
        expect(res.status).toBe(200);
      }
      await new Promise((r) => setTimeout(r, 50));
      expect(onMessage).toHaveBeenCalledTimes(1);
    } finally {
      server.close();
    }
  });
});
