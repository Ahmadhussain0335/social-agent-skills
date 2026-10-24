import { createHmac, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server } from 'node:http';

// Webhook endpoint for the support bot. Meta requires a public HTTPS URL with a valid
// certificate, so this listens on localhost and the user exposes it through a tunnel.
// https://developers.facebook.com/documentation/business-messaging/whatsapp/webhooks/create-webhook-endpoint

const MAX_BODY = 4 * 1024 * 1024;

export interface InboundMessage {
  id: string;
  from: string;
  timestamp: number;
  type: string;
  text?: string;
}

export function verifySignature(rawBody: Buffer, header: string | undefined, appSecret: string): boolean {
  if (!header?.startsWith('sha256=')) return false;
  const expected = createHmac('sha256', appSecret).update(rawBody).digest();
  const given = Buffer.from(header.slice('sha256='.length), 'hex');
  return given.length === expected.length && timingSafeEqual(given, expected);
}

/** Extracts customer messages from a webhook payload; statuses and other fields are ignored. */
export function extractMessages(payload: unknown): InboundMessage[] {
  const out: InboundMessage[] = [];
  const entries = (payload as { entry?: unknown[] })?.entry ?? [];
  for (const entry of entries) {
    for (const change of (entry as { changes?: unknown[] }).changes ?? []) {
      const value = (change as { field?: string; value?: { messages?: unknown[] } }).value;
      if ((change as { field?: string }).field !== 'messages') continue;
      for (const m of value?.messages ?? []) {
        const msg = m as {
          id?: string;
          from?: string;
          timestamp?: string;
          type?: string;
          text?: { body?: string };
          button?: { text?: string };
          interactive?: { button_reply?: { title?: string }; list_reply?: { title?: string } };
        };
        if (!msg.id || !msg.from) continue;
        out.push({
          id: msg.id,
          from: msg.from,
          timestamp: Number(msg.timestamp ?? 0) * 1000,
          type: msg.type ?? 'unknown',
          text:
            msg.text?.body ??
            msg.button?.text ??
            msg.interactive?.button_reply?.title ??
            msg.interactive?.list_reply?.title,
        });
      }
    }
  }
  return out;
}

export interface WebhookOptions {
  verifyToken: string;
  appSecret: string;
  onMessage: (message: InboundMessage) => Promise<void> | void;
  onError?: (error: unknown) => void;
}

export function createWebhookServer(opts: WebhookOptions): Server {
  // Meta retries deliveries for up to 7 days, so the same message id can arrive again.
  const seen = new Set<string>();

  return createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');

    if (req.method === 'GET') {
      const ok =
        url.searchParams.get('hub.mode') === 'subscribe' &&
        safeEqual(url.searchParams.get('hub.verify_token') ?? '', opts.verifyToken);
      res
        .writeHead(ok ? 200 : 403, { 'content-type': 'text/plain' })
        .end(ok ? (url.searchParams.get('hub.challenge') ?? '') : '');
      return;
    }
    if (req.method !== 'POST') {
      res.writeHead(405).end();
      return;
    }

    let body: Buffer;
    try {
      body = await readBody(req);
    } catch {
      res.writeHead(413).end();
      return;
    }
    if (!verifySignature(body, header(req, 'x-hub-signature-256'), opts.appSecret)) {
      res.writeHead(401).end();
      return;
    }
    // Acknowledge first; Meta expects a fast 200 and retries otherwise.
    res.writeHead(200).end();

    try {
      for (const message of extractMessages(JSON.parse(body.toString('utf8')))) {
        if (seen.has(message.id)) continue;
        seen.add(message.id);
        if (seen.size > 10_000) seen.delete(seen.values().next().value as string);
        await opts.onMessage(message);
      }
    } catch (error) {
      opts.onError?.(error);
    }
  });
}

function header(req: IncomingMessage, name: string): string | undefined {
  const value = req.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}
