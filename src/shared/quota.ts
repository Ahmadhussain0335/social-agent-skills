import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export interface QuotaLedgerOptions {
  /** File that persists usage between script runs. */
  path: string;
  dailyLimit: number;
  /** IANA zone in which the platform resets its quota, e.g. America/Los_Angeles for YouTube. */
  resetTimeZone: string;
  now?: () => Date;
}

interface LedgerFile {
  day: string;
  used: number;
}

/**
 * Local estimate of daily API quota use. The platform is the source of truth; this exists
 * to stop a run before it starts when the estimate says it cannot finish.
 */
export class QuotaLedger {
  private readonly now: () => Date;

  constructor(private readonly opts: QuotaLedgerOptions) {
    this.now = opts.now ?? (() => new Date());
  }

  today(): string {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: this.opts.resetTimeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(this.now());
  }

  used(): number {
    const file = this.read();
    return file && file.day === this.today() ? file.used : 0;
  }

  remaining(): number {
    return Math.max(0, this.opts.dailyLimit - this.used());
  }

  canSpend(units: number): boolean {
    return units <= this.remaining();
  }

  record(units: number): void {
    const used = this.used() + units;
    mkdirSync(dirname(this.opts.path), { recursive: true, mode: 0o700 });
    writeFileSync(this.opts.path, JSON.stringify({ day: this.today(), used } satisfies LedgerFile));
  }

  private read(): LedgerFile | undefined {
    if (!existsSync(this.opts.path)) return undefined;
    try {
      return JSON.parse(readFileSync(this.opts.path, 'utf8')) as LedgerFile;
    } catch {
      return undefined;
    }
  }
}
