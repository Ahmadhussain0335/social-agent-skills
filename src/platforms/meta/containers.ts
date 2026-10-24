import { PlatformError } from '../../shared/errors';
import type { GraphClient } from './graph';

// Instagram and Threads create a media container first and publish it once Meta has
// fetched and processed the media. Both document polling at most once a minute for up
// to five minutes; images usually finish within seconds, so the first check is early.

export interface WaitOptions {
  /** Field holding the status: "status_code" on Instagram, "status" on Threads. */
  field: 'status_code' | 'status';
  sleep?: (ms: number) => Promise<void>;
  firstDelayMs?: number;
  intervalMs?: number;
  attempts?: number;
}

export async function waitForContainer(client: GraphClient, containerId: string, opts: WaitOptions): Promise<void> {
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const attempts = opts.attempts ?? 6;
  await sleep(opts.firstDelayMs ?? 5_000);
  for (let i = 0; i < attempts; i++) {
    const res = (await client.get(containerId, { fields: `${opts.field},error_message` })) as Record<
      string,
      string | undefined
    >;
    const status = res[opts.field];
    if (status === 'FINISHED' || status === 'PUBLISHED') return;
    if (status === 'ERROR' || status === 'EXPIRED') {
      throw new PlatformError(
        'META_MEDIA_FAILED',
        `Media processing ${status === 'EXPIRED' ? 'expired' : 'failed'}${res.error_message ? `: ${res.error_message}` : ''}.`,
        'Check the media format, size and that its URL is publicly reachable, then create a new post.',
      );
    }
    if (i < attempts - 1) await sleep(opts.intervalMs ?? 60_000);
  }
  throw new PlatformError(
    'META_MEDIA_TIMEOUT',
    'Media is still processing after several minutes.',
    'Large videos can take longer. Nothing was published; run the publish step again later.',
  );
}
