import { createInterface } from 'node:readline/promises';

export interface Tty {
  isInteractive(): boolean;
  ask(question: string): Promise<string>;
}

export const processTty: Tty = {
  isInteractive: () => Boolean(process.stdin.isTTY && process.stdout.isTTY),
  async ask(question) {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    try {
      return (await rl.question(question)).trim();
    } finally {
      rl.close();
    }
  },
};

export async function confirm(tty: Tty, question: string): Promise<boolean> {
  const answer = (await tty.ask(`${question} [y/N] `)).toLowerCase();
  return answer === 'y' || answer === 'yes';
}

/** Lets the user pick items by number, comma-separated; "a" selects all. */
export async function chooseMany<T>(
  tty: Tty,
  question: string,
  items: readonly T[],
  label: (item: T) => string,
): Promise<T[]> {
  const lines = items.map((item, i) => `  ${i + 1}. ${label(item)}`).join('\n');
  const answer = await tty.ask(`${question}\n${lines}\nEnter numbers separated by commas, or "a" for all: `);
  if (answer.toLowerCase() === 'a') return [...items];
  const picked = answer
    .split(',')
    .map((part) => Number.parseInt(part.trim(), 10) - 1)
    .filter((i) => i >= 0 && i < items.length);
  return [...new Set(picked)].map((i) => items[i] as T);
}
