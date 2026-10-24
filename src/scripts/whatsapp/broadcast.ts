import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  BROADCAST_FILES,
  type BroadcastConfig,
  fillParams,
  requireApprovedTemplate,
  requireSendApproval,
  SEND_CHECKPOINT,
  sendBroadcast,
} from '../../platforms/whatsapp/broadcast';
import { phoneNumberId, ratesPath, wabaId, waClient } from '../../platforms/whatsapp/config';
import { maskPhone, readContacts, selectContacts } from '../../platforms/whatsapp/contacts';
import { estimateCost, readRates } from '../../platforms/whatsapp/pricing';
import { ContactStore } from '../../platforms/whatsapp/store';
import { approveCheckpoint, newState, saveState } from '../../shared/approval';
import { PlatformError } from '../../shared/errors';
import { log, printJson } from '../../shared/log';
import { processTty } from '../../shared/prompt';
import { requireFlag, runScript } from '../run';

const HELP = `
Usage: node scripts/broadcast.mjs <--init|--plan|--approve|--send> --dir <broadcast-folder>

Sends an approved WhatsApp template to opted-in contacts only, through the official
Cloud API. Contacts without a recorded opt-in, or who opted out, are never messaged.

Folder:
  broadcast.json   template name, language, category, body parameters, rate
  contacts.csv     columns: phone, opt_in_at (required); name, opt_in_source, opted_out_at, ...
  results.jsonl    written while sending; makes --send resumable without double-sending

Actions:
  --init       create broadcast.json and a contacts.csv header
  --plan       show eligible and excluded contacts and the estimated cost; sends nothing
  --approve    user approves recipients, template and cost; interactive terminal only
  --send       send to approved recipients; stops on account-level errors

Environment:
  WA_ACCESS_TOKEN, WA_PHONE_NUMBER_ID, WA_WABA_ID   required for --send
  WA_RATES_PATH   rates file (default <config dir>/whatsapp/rates.json), see references/pricing.md
`;

runScript(
  HELP,
  {
    dir: { type: 'string' },
    init: { type: 'boolean' },
    plan: { type: 'boolean' },
    approve: { type: 'boolean' },
    send: { type: 'boolean' },
  },
  async (flags) => {
    const dir = resolve(requireFlag(flags, 'dir'));

    if (flags.init) {
      if (existsSync(join(dir, BROADCAST_FILES.config)))
        throw new PlatformError('BROADCAST_EXISTS', 'broadcast.json already exists.');
      const config: BroadcastConfig = {
        template: { name: 'order_update', language: 'en', category: 'UTILITY' },
        bodyParams: ['{name}'],
        ratePerSecond: 10,
      };
      saveState(dir, newState('wa-broadcast'));
      writeFileSync(join(dir, BROADCAST_FILES.config), `${JSON.stringify(config, null, 2)}\n`);
      if (!existsSync(join(dir, BROADCAST_FILES.contacts))) {
        writeFileSync(join(dir, BROADCAST_FILES.contacts), 'phone,name,opt_in_at,opt_in_source,opted_out_at\n');
      }
      printJson({ ok: true, dir });
      return;
    }

    const config = JSON.parse(readFileSync(join(dir, BROADCAST_FILES.config), 'utf8')) as BroadcastConfig;
    const selection = selectContacts(readContacts(join(dir, BROADCAST_FILES.contacts)), {
      category: config.template.category,
      optedOut: ContactStore.forEnv().optedOut(),
    });
    // Fail early if a template parameter column is missing for any eligible contact.
    for (const contact of selection.eligible) fillParams(config.bodyParams ?? [], contact.row);

    const excludedByReason: Record<string, number> = {};
    for (const e of selection.excluded) excludedByReason[e.reason] = (excludedByReason[e.reason] ?? 0) + 1;
    const cost = estimateCost(selection.eligible, config.template.category, readRates(ratesPath()));
    const plan = {
      template: config.template,
      recipients: selection.eligible.length,
      excluded: excludedByReason,
      cost,
      sample: selection.eligible.slice(0, 3).map((c) => maskPhone(c.phone)),
    };

    if (flags.plan) {
      printJson(plan);
      return;
    }

    if (flags.approve) {
      if (selection.eligible.length === 0) throw new PlatformError('WA_NO_RECIPIENTS', 'No eligible recipients.');
      const summary = [
        `Template: ${config.template.name} (${config.template.language}), category ${config.template.category}`,
        `Recipients: ${plan.recipients} opted-in contacts`,
        `Excluded: ${JSON.stringify(plan.excluded)}`,
        `Estimated cost: ${cost.total} ${cost.currency} (rate card dated ${cost.effectiveDate})`,
        ...cost.notes,
      ].join('\n');
      await approveCheckpoint({
        dir,
        def: SEND_CHECKPOINT,
        files: [BROADCAST_FILES.config, BROADCAST_FILES.contacts],
        tty: processTty,
        summary,
      });
      printJson({ ok: true, approved: SEND_CHECKPOINT.id, recipients: plan.recipients });
      return;
    }

    if (flags.send) {
      await requireSendApproval(dir);
      const client = waClient();
      await requireApprovedTemplate(client, wabaId(), config);
      const outcome = await sendBroadcast({
        dir,
        client,
        phoneNumberId: phoneNumberId(),
        config,
        contacts: selection.eligible,
        onResult: (r) => log.info(`${r.status.padEnd(7)} ${maskPhone(r.phone)}${r.reason ? `  ${r.reason}` : ''}`),
      });
      printJson({ ok: !outcome.stoppedBy, ...outcome, results: join(dir, BROADCAST_FILES.results) });
      if (outcome.stoppedBy) process.exitCode = 1;
      return;
    }

    process.stderr.write(`${HELP.trim()}\n`);
    process.exitCode = 2;
  },
);
