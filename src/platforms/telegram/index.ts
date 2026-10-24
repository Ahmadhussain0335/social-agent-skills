import { openAsBlob } from 'node:fs';
import { basename, join } from 'node:path';
import { PlatformError } from '../../shared/errors';
import { fetchWithRetry } from '../../shared/http';
import { isRemote, type PostDraft } from '../../shared/post-project';
import type { CheckResult } from '../meta/facebook';
import { registerPostPlatform } from '../posting';

// Telegram Bot API, posting to a channel or group the bot administers.
// https://core.telegram.org/bots/api  (limits checked 2026-10-24: text 4096, caption 1024,
// photo upload 10 MB, other files 50 MB; no scheduling in the Bot API)

export const TG_ENV = { botToken: 'TELEGRAM_BOT_TOKEN', chatId: 'TELEGRAM_CHAT_ID' } as const;
export const TG_LIMITS = { text: 4096, caption: 1024, albumMin: 2, albumMax: 10 } as const;

export function checkTelegramPost(draft: PostDraft): CheckResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  const media = draft.media ?? [];
  const text = draft.text ?? '';
  if (draft.platform !== 'telegram') errors.push('platform must be "telegram"');
  if (!['text', 'photo', 'video', 'album'].includes(draft.kind))
    errors.push('kind must be text, photo, video or album');
  if (draft.kind === 'text' && !text.trim()) errors.push('text is required');
  if (draft.kind === 'text' && text.length > TG_LIMITS.text) errors.push(`text exceeds ${TG_LIMITS.text} characters`);
  if (draft.kind !== 'text' && text.length > TG_LIMITS.caption)
    errors.push(`caption exceeds ${TG_LIMITS.caption} characters`);
  if ((draft.kind === 'photo' || draft.kind === 'video') && media.length !== 1)
    errors.push(`${draft.kind} posts need exactly one file`);
  if (draft.kind === 'album' && (media.length < TG_LIMITS.albumMin || media.length > TG_LIMITS.albumMax))
    errors.push('albums need 2-10 photos or videos');
  if (draft.scheduledAt) errors.push('the Telegram Bot API has no scheduling; use content-calendar');
  const mode = draft.options?.parseMode;
  if (mode !== undefined && mode !== 'HTML')
    errors.push('options.parseMode may only be "HTML" (plain text is the default)');
  if (mode === 'HTML' && /<(?!\/?(b|strong|i|em|u|ins|s|strike|del|a|code|pre|blockquote|tg-spoiler)\b)/i.test(text)) {
    warnings.push('text contains HTML tags Telegram may reject');
  }
  return { ok: errors.length === 0, errors, warnings };
}

type FetchLike = typeof fetch;

async function call(
  token: string,
  method: string,
  body: FormData | Record<string, unknown>,
  fetchImpl?: FetchLike,
): Promise<Record<string, unknown>> {
  const isForm = body instanceof FormData;
  const res = await fetchWithRetry(
    `https://api.telegram.org/bot${token}/${method}`,
    {
      method: 'POST',
      body: isForm ? body : JSON.stringify(body),
      headers: isForm ? undefined : { 'content-type': 'application/json' },
    },
    { retryOn: [429], fetchImpl },
  );
  const json = (await res.json()) as {
    ok: boolean;
    result?: Record<string, unknown>;
    description?: string;
    error_code?: number;
  };
  if (!json.ok) {
    const hint =
      json.error_code === 403
        ? 'The bot is not an admin of the chat or was removed. Add it as an administrator with permission to post.'
        : json.error_code === 400 && /chat not found/i.test(json.description ?? '')
          ? 'Check TELEGRAM_CHAT_ID (use @channelusername or the numeric -100... id).'
          : undefined;
    throw new PlatformError(
      `TELEGRAM_${json.error_code ?? res.status}`,
      json.description ?? 'Telegram API error',
      hint,
    );
  }
  return json.result ?? {};
}

export async function publishTelegram(
  dir: string,
  draft: PostDraft,
  env: NodeJS.ProcessEnv,
  fetchImpl?: FetchLike,
): Promise<Record<string, unknown>> {
  const token = env[TG_ENV.botToken];
  const chatId = (draft.options?.chatId as string | undefined) ?? env[TG_ENV.chatId];
  if (!token)
    throw new PlatformError(
      'TELEGRAM_ENV_MISSING',
      'TELEGRAM_BOT_TOKEN is not set.',
      'Create a bot with @BotFather; see references/setup.md.',
    );
  if (!chatId) throw new PlatformError('TELEGRAM_ENV_MISSING', 'Set TELEGRAM_CHAT_ID or options.chatId.');
  const parse = draft.options?.parseMode === 'HTML' ? { parse_mode: 'HTML' } : {};
  const media = draft.media ?? [];

  const fileField = async (form: FormData, name: string, source: string) => {
    if (isRemote(source)) return source;
    form.set(name, await openAsBlob(join(dir, source)), basename(source));
    return `attach://${name}`;
  };

  let result: Record<string, unknown> | Record<string, unknown>[];
  if (draft.kind === 'text') {
    result = await call(
      token,
      'sendMessage',
      { chat_id: chatId, text: draft.text, ...parse, link_preview_options: { is_disabled: false } },
      fetchImpl,
    );
  } else if (draft.kind === 'album') {
    const form = new FormData();
    const items = [];
    for (const [i, m] of media.entries()) {
      items.push({
        type: m.type === 'video' ? 'video' : 'photo',
        media: await fileField(form, `file${i}`, m.source),
        ...(i === 0 ? { caption: draft.text, ...parse } : {}),
      });
    }
    form.set('chat_id', chatId);
    form.set('media', JSON.stringify(items));
    result = (await call(token, 'sendMediaGroup', form, fetchImpl)) as unknown as Record<string, unknown>[];
  } else {
    const m = media[0] as (typeof media)[number];
    const field = draft.kind === 'photo' ? 'photo' : 'video';
    const form = new FormData();
    form.set('chat_id', chatId);
    if (draft.text) form.set('caption', draft.text);
    if (parse.parse_mode) form.set('parse_mode', parse.parse_mode);
    if (isRemote(m.source)) form.set(field, m.source);
    else form.set(field, await openAsBlob(join(dir, m.source)), basename(m.source));
    result = await call(token, draft.kind === 'photo' ? 'sendPhoto' : 'sendVideo', form, fetchImpl);
  }
  const first = Array.isArray(result) ? result[0] : result;
  const chat = first?.chat as { username?: string } | undefined;
  const id = String(first?.message_id ?? '');
  return { id, url: chat?.username ? `https://t.me/${chat.username}/${id}` : undefined };
}

registerPostPlatform({
  id: 'telegram',
  label: 'Telegram channel',
  kinds: ['text', 'photo', 'video', 'album'],
  textLimit: TG_LIMITS.text,
  scheduling: false,
  notes: [
    'Posts as your bot to a channel or group where it is an admin.',
    'Captions are limited to 1,024 characters.',
    'Plain text by default; options.parseMode "HTML" for formatting.',
  ],
  check: (draft) => checkTelegramPost(draft),
  publish: (dir, draft, env) => publishTelegram(dir, draft, env),
});
