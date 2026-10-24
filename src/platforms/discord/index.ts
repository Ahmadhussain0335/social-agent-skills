import { openAsBlob } from 'node:fs';
import { basename, join } from 'node:path';
import { PlatformError } from '../../shared/errors';
import { fetchWithRetry } from '../../shared/http';
import { isRemote, type PostDraft } from '../../shared/post-project';
import type { CheckResult } from '../meta/facebook';
import { registerPostPlatform } from '../posting';

// Discord channel webhooks: one credential scoped to one channel, no bot needed.
// https://docs.discord.com/developers/resources/webhook (content 2000 chars, 10 embeds,
// 20 MiB per file by default). The webhook URL is a secret: anyone with it can post.

export const DC_ENV = { webhookUrl: 'DISCORD_WEBHOOK_URL' } as const;

export function checkDiscordPost(draft: PostDraft): CheckResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  const media = draft.media ?? [];
  if (draft.platform !== 'discord') errors.push('platform must be "discord"');
  if (!['text', 'media'].includes(draft.kind)) errors.push('kind must be text or media');
  const text = draft.link ? `${draft.text ?? ''}\n${draft.link}`.trim() : (draft.text ?? '');
  if (!text.trim() && media.length === 0) errors.push('text or media is required');
  if (text.length > 2000) errors.push('text exceeds 2,000 characters');
  if (media.length > 10) errors.push('at most 10 attachments');
  if (media.some((m) => isRemote(m.source)))
    errors.push('attachments must be local files (remote URLs can go in the text)');
  if (draft.scheduledAt) errors.push('webhooks have no scheduling; use content-calendar');
  if (/@(everyone|here)|<@&\d+>/.test(text) && !draft.options?.allowMentions) {
    warnings.push('@everyone, @here and role mentions will not ping unless options.allowMentions is true');
  }
  return { ok: errors.length === 0, errors, warnings };
}

export async function publishDiscord(
  dir: string,
  draft: PostDraft,
  env: NodeJS.ProcessEnv,
  fetchImpl?: typeof fetch,
): Promise<Record<string, unknown>> {
  const envName = (draft.options?.webhookEnv as string | undefined) ?? DC_ENV.webhookUrl;
  const webhook = env[envName];
  if (!webhook || !/^https:\/\/(discord\.com|discordapp\.com)\/api\/webhooks\//.test(webhook)) {
    throw new PlatformError(
      'DISCORD_ENV_MISSING',
      `${envName} is not set to a Discord webhook URL.`,
      'Channel settings > Integrations > Webhooks > New Webhook > Copy URL.',
    );
  }
  const content = draft.link ? `${draft.text ?? ''}\n${draft.link}`.trim() : (draft.text ?? '');
  const payload = {
    content,
    // Never ping everyone or roles by accident.
    allowed_mentions: draft.options?.allowMentions ? { parse: ['users', 'roles', 'everyone'] } : { parse: [] },
    ...(draft.options?.username ? { username: draft.options.username } : {}),
  };
  const form = new FormData();
  form.set('payload_json', JSON.stringify(payload));
  for (const [i, m] of (draft.media ?? []).entries())
    form.set(`files[${i}]`, await openAsBlob(join(dir, m.source)), basename(m.source));
  const url = new URL(webhook);
  url.searchParams.set('wait', 'true');
  const res = await fetchWithRetry(url, { method: 'POST', body: form }, { retryOn: [429], fetchImpl });
  const body = (await res.json().catch(() => ({}))) as { id?: string; channel_id?: string; message?: string };
  if (!res.ok) {
    throw new PlatformError(
      `DISCORD_${res.status}`,
      body.message ?? `Discord webhook failed (HTTP ${res.status})`,
      res.status === 404
        ? 'The webhook was deleted. Create a new one and update the environment variable; do not retry the old URL.'
        : undefined,
    );
  }
  return { id: body.id, channelId: body.channel_id };
}

registerPostPlatform({
  id: 'discord',
  label: 'Discord channel',
  kinds: ['text', 'media'],
  textLimit: 2000,
  scheduling: false,
  notes: [
    'Posts through a channel webhook.',
    'Mentions never ping unless options.allowMentions is true.',
    'Up to 10 local attachments, 20 MiB each by default.',
  ],
  check: (draft) => checkDiscordPost(draft),
  publish: (dir, draft, env) => publishDiscord(dir, draft, env),
});
