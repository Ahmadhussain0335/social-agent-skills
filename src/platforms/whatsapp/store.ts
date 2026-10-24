import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { platformDir } from '../../shared/config-paths';
import { writeSecretJson } from '../../shared/token-store';

// Phone numbers are personal data (GDPR). This store keeps only what the rules need:
// the time of each customer's last inbound message (24-hour window) and opt-outs.
// It lives in the user config directory with mode 0600; window entries expire after 7 days.

const WINDOW_MS = 24 * 60 * 60 * 1000;
const RETAIN_MS = 7 * 24 * 60 * 60 * 1000;

interface StoreFile {
  lastInbound: Record<string, number>;
  optedOut: Record<string, string>;
}

export class ContactStore {
  private data: StoreFile;

  constructor(
    private readonly path: string,
    private readonly now: () => number = Date.now,
  ) {
    this.data = existsSync(path)
      ? (JSON.parse(readFileSync(path, 'utf8')) as StoreFile)
      : { lastInbound: {}, optedOut: {} };
  }

  static forEnv(env: NodeJS.ProcessEnv = process.env): ContactStore {
    return new ContactStore(join(platformDir('whatsapp', env), 'contacts-store.json'));
  }

  recordInbound(phone: string, at = this.now()): void {
    this.data.lastInbound[phone] = Math.max(this.data.lastInbound[phone] ?? 0, at);
    this.save();
  }

  /** True while the 24-hour customer service window is open for this phone. */
  windowOpen(phone: string): boolean {
    const last = this.data.lastInbound[phone];
    return last !== undefined && this.now() - last < WINDOW_MS;
  }

  optOut(phone: string): void {
    this.data.optedOut[phone] = new Date(this.now()).toISOString();
    this.save();
  }

  optIn(phone: string): void {
    delete this.data.optedOut[phone];
    this.save();
  }

  optedOut(): Set<string> {
    return new Set(Object.keys(this.data.optedOut));
  }

  private save(): void {
    const cutoff = this.now() - RETAIN_MS;
    for (const [phone, at] of Object.entries(this.data.lastInbound)) {
      if (at < cutoff) delete this.data.lastInbound[phone];
    }
    writeSecretJson(this.path, this.data);
  }
}
