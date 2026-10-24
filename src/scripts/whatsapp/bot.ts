import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  checkKnowledgeBase,
  decide,
  GO_LIVE_CHECKPOINT,
  KB_FILE,
  type KnowledgeBase,
  orderLookup,
} from '../../platforms/whatsapp/bot';
import { phoneNumberId, requireEnv, WA_ENV, waClient } from '../../platforms/whatsapp/config';
import { maskPhone } from '../../platforms/whatsapp/contacts';
import { ContactStore } from '../../platforms/whatsapp/store';
import { createWebhookServer } from '../../platforms/whatsapp/webhook';
import { approveCheckpoint, loadState, newState, saveState, verifyCheckpoint } from '../../shared/approval';
import { PlatformError } from '../../shared/errors';
import { log, printJson } from '../../shared/log';
import { processTty } from '../../shared/prompt';
import { requireFlag, runScript } from '../run';

const HELP = `
Usage: node scripts/bot.mjs <action> --dir <bot-folder> [options]

Business-scoped WhatsApp support bot. It replies only with answers from support-kb.json
(FAQs, order status lookups, opt-out handling) and hands everything else to a person.
It uses no AI model, which keeps it within Meta's WhatsApp Business terms that prohibit
general-purpose AI assistants (effective 2026-01-15). Replies are free-form messages, so
they are only sent inside the 24-hour customer service window opened by the customer.

Actions:
  --init                 create support-kb.json skeleton (and state.json)
  --check                validate support-kb.json
  --test "<message>"     show what the bot would reply; sends nothing
  --approve              user approves the knowledge base for live use; interactive terminal only
  --serve [--port 8787]  run the webhook; expose it with an HTTPS tunnel and register the URL in Meta

Environment (for --serve):
  WA_ACCESS_TOKEN, WA_PHONE_NUMBER_ID   send replies
  WA_APP_SECRET                         verify webhook signatures (required)
  WA_VERIFY_TOKEN                       your chosen verify token for the webhook handshake

Unanswered messages are logged to <bot-folder>/handoff.jsonl for a person to follow up.
Pricing: since 2026-10-01 service replies are charged after 1,000 free per month per number.
`;

runScript(
  HELP,
  {
    dir: { type: 'string' },
    init: { type: 'boolean' },
    check: { type: 'boolean' },
    test: { type: 'string' },
    approve: { type: 'boolean' },
    serve: { type: 'boolean' },
    port: { type: 'string' },
  },
  async (flags) => {
    const dir = resolve(requireFlag(flags, 'dir'));

    if (flags.init) {
      if (existsSync(join(dir, KB_FILE))) throw new PlatformError('KB_EXISTS', `${KB_FILE} already exists.`);
      const kb: KnowledgeBase = {
        business: {
          name: 'Your Business',
          handoffMessage: 'Thanks for your message. A member of our team will reply during opening hours.',
        },
        faqs: [
          {
            id: 'hours',
            keywords: ['hours', 'open', 'opening', 'close'],
            answer: 'We are open Monday to Friday, 9:00 to 17:00.',
          },
        ],
      };
      saveState(dir, newState('wa-support-bot'));
      writeFileSync(join(dir, KB_FILE), `${JSON.stringify(kb, null, 2)}\n`);
      printJson({ ok: true, wrote: join(dir, KB_FILE) });
      return;
    }

    const kb = JSON.parse(readFileSync(join(dir, KB_FILE), 'utf8')) as KnowledgeBase;
    const errors = checkKnowledgeBase(kb);
    if (flags.check) {
      printJson({ ok: errors.length === 0, errors });
      if (errors.length > 0) process.exitCode = 1;
      return;
    }
    if (errors.length > 0) throw new PlatformError('WA_KB_INVALID', errors.join('; '));

    if (typeof flags.test === 'string') {
      printJson(decide(kb, flags.test, orderLookup(dir, kb)));
      return;
    }

    if (flags.approve) {
      const summary = [
        `Business: ${kb.business.name}`,
        `Hand-off message: ${kb.business.handoffMessage}`,
        `FAQs (${kb.faqs.length}):`,
        ...kb.faqs.map((f) => `  [${f.id}] keywords: ${f.keywords.join(', ')}\n      reply: ${f.answer}`),
        kb.orders ? `Order lookup: ${kb.orders.file}, reply "${kb.orders.reply}"` : 'Order lookup: off',
      ].join('\n');
      await approveCheckpoint({ dir, def: GO_LIVE_CHECKPOINT, files: [KB_FILE], tty: processTty, summary });
      printJson({ ok: true, approved: GO_LIVE_CHECKPOINT.id });
      return;
    }

    if (flags.serve) {
      const verified = await verifyCheckpoint(dir, loadState(dir), GO_LIVE_CHECKPOINT.id, [KB_FILE]);
      if (!verified.ok) {
        throw new PlatformError(
          'APPROVAL_REQUIRED',
          `The knowledge base is not approved for live use: ${verified.problems.join('; ')}`,
          'Ask the user to run --approve in their own terminal.',
        );
      }
      const appSecret = requireEnv(
        WA_ENV.appSecret,
        process.env,
        'The app secret is needed to verify that webhook calls come from Meta.',
      );
      const verifyToken = requireEnv(
        WA_ENV.verifyToken,
        process.env,
        'Choose any long random string and enter the same value in the Meta webhook settings.',
      );
      const client = waClient();
      const fromId = phoneNumberId();
      const store = ContactStore.forEnv();
      const lookup = orderLookup(dir, kb);

      const server = createWebhookServer({
        verifyToken,
        appSecret,
        onError: (error) => log.error(`webhook error: ${(error as Error).message}`),
        onMessage: async (message) => {
          store.recordInbound(message.from, message.timestamp || Date.now());
          const decision = decide(kb, message.text ?? '', lookup);
          if (decision.kind === 'opt_out') store.optOut(message.from);
          if (decision.kind === 'opt_in') store.optIn(message.from);
          if (decision.kind === 'handoff') {
            appendHandoff(dir, message.from, message.text ?? `[${message.type}]`);
          }
          if (!store.windowOpen(message.from)) return;
          await client.post(`${fromId}/messages`, {
            messaging_product: 'whatsapp',
            recipient_type: 'individual',
            to: message.from,
            type: 'text',
            text: JSON.stringify({ body: decision.text, preview_url: false }),
          });
          log.info(`${decision.kind.padEnd(8)} ${maskPhone(message.from)}`);
        },
      });
      const port = Number(flags.port ?? 8787);
      server.listen(port, '127.0.0.1', () => {
        log.info(`Webhook listening on http://127.0.0.1:${port}`);
        log.info(`Expose it over HTTPS (for example: cloudflared tunnel --url http://127.0.0.1:${port})`);
        log.info(
          'Then set that https URL and WA_VERIFY_TOKEN as the callback in the Meta App Dashboard > WhatsApp > Configuration.',
        );
      });
      return;
    }

    process.stderr.write(`${HELP.trim()}\n`);
    process.exitCode = 2;
  },
);

function appendHandoff(dir: string, phone: string, text: string): void {
  appendFileSync(join(dir, 'handoff.jsonl'), `${JSON.stringify({ at: new Date().toISOString(), phone, text })}\n`);
}
