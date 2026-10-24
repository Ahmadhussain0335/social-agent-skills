import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { wabaId, waClient } from '../../platforms/whatsapp/config';
import { checkTemplate, listTemplates, submitTemplate, type TemplateDraft } from '../../platforms/whatsapp/templates';
import { approveCheckpoint, loadState, newState, saveState, verifyCheckpoint } from '../../shared/approval';
import { PlatformError } from '../../shared/errors';
import { printJson } from '../../shared/log';
import { processTty } from '../../shared/prompt';
import { requireFlag, runScript } from '../run';

const HELP = `
Usage: node scripts/templates.mjs <action> [options]

Drafts WhatsApp message templates and submits them to Meta for review through the
official Cloud API. Templates are required for any message sent outside the 24-hour
customer service window, including every broadcast.

Actions:
  --init --dir <folder> --name <name>   create <folder>/template.json skeleton
  --check --dir <folder>                validate template.json (exit 1 on errors)
  --approve --dir <folder>              user approves the exact template; interactive terminal only
  --submit --dir <folder>               submit the approved template to Meta for review
  --status [--name <name>]              list templates with status, category and quality

Environment:
  WA_ACCESS_TOKEN   System User token with whatsapp_business_management
  WA_WABA_ID        WhatsApp Business Account ID
  WA_APP_SECRET     optional; adds appsecret_proof to every call

Meta reviews templates within 24 hours. A UTILITY template with promotional content is
approved as MARKETING, which is priced higher.
`;

const TEMPLATE_FILE = 'template.json';
const SUBMIT = { id: 'submit', title: 'Submit this template to Meta', requires: [] };

runScript(
  HELP,
  {
    dir: { type: 'string' },
    name: { type: 'string' },
    init: { type: 'boolean' },
    check: { type: 'boolean' },
    approve: { type: 'boolean' },
    submit: { type: 'boolean' },
    status: { type: 'boolean' },
  },
  async (flags) => {
    if (flags.status) {
      const templates = await listTemplates(waClient(), wabaId(), flags.name as string | undefined);
      printJson({ count: templates.length, templates });
      return;
    }

    const dir = resolve(requireFlag(flags, 'dir'));
    if (flags.init) {
      if (existsSync(join(dir, TEMPLATE_FILE)))
        throw new PlatformError('TEMPLATE_EXISTS', `${TEMPLATE_FILE} already exists.`);
      const draft: TemplateDraft = {
        name: requireFlag(flags, 'name'),
        language: 'en',
        category: 'UTILITY',
        components: [
          {
            type: 'BODY',
            text: 'Hi {{1}}, your order {{2}} has shipped.',
            example: { body_text: [['Ayesha', 'A-1042']] },
          },
        ],
      };
      saveState(dir, newState(`wa-template-${draft.name}`));
      writeFileSync(join(dir, TEMPLATE_FILE), `${JSON.stringify(draft, null, 2)}\n`);
      printJson({ ok: true, wrote: join(dir, TEMPLATE_FILE) });
      return;
    }

    const draft = JSON.parse(readFileSync(join(dir, TEMPLATE_FILE), 'utf8')) as TemplateDraft;
    const report = checkTemplate(draft);

    if (flags.check) {
      printJson(report);
      if (!report.ok) process.exitCode = 1;
      return;
    }
    if (!report.ok) throw new PlatformError('WA_TEMPLATE_INVALID', report.errors.join('; '));

    if (flags.approve) {
      const summary = [
        `Template: ${draft.name} (${draft.language})    Category: ${draft.category}`,
        ...draft.components.map((c) => `${c.type}: ${c.text ?? JSON.stringify(c.buttons ?? c.format ?? '')}`),
        ...report.warnings.map((w) => `Warning: ${w}`),
      ].join('\n');
      await approveCheckpoint({ dir, def: SUBMIT, files: [TEMPLATE_FILE], tty: processTty, summary });
      printJson({ ok: true, approved: SUBMIT.id });
      return;
    }

    if (flags.submit) {
      const verified = await verifyCheckpoint(dir, loadState(dir), SUBMIT.id, [TEMPLATE_FILE]);
      if (!verified.ok) {
        throw new PlatformError(
          'APPROVAL_REQUIRED',
          `Template is not approved for submission: ${verified.problems.join('; ')}`,
          'Ask the user to run the --approve action in their own terminal.',
        );
      }
      const result = await submitTemplate(waClient(), wabaId(), draft);
      printJson({ ok: true, result, next: 'Meta reviews within 24 hours. Check with --status.' });
      return;
    }

    process.stderr.write(`${HELP.trim()}\n`);
    process.exitCode = 2;
  },
);
