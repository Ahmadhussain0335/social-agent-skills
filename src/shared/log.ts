// Values that must never reach stdout, stderr or files. Env vars named here are masked
// by value; the patterns catch tokens that arrive in API responses or error bodies.
const SECRET_ENV_NAMES = /(TOKEN|SECRET|KEY|PASSWORD|CREDENTIAL)/i;
const SECRET_PATTERNS: RegExp[] = [
  /\bBearer\s+[A-Za-z0-9._~+/-]+=*/g,
  /\bya29\.[A-Za-z0-9._-]+/g,
  /\b1\/\/[A-Za-z0-9._-]{20,}/g,
  /\bAIza[0-9A-Za-z_-]{35}\b/g,
  /("?(?:access_token|refresh_token|id_token|client_secret|api_key|code_verifier)"?\s*[:=]\s*"?)[^"&\s,}]+/gi,
];
const MASK = '[REDACTED]';

export function redact(text: string, env: NodeJS.ProcessEnv = process.env): string {
  let out = text;
  for (const [name, value] of Object.entries(env)) {
    if (value && value.length >= 8 && SECRET_ENV_NAMES.test(name) && !name.endsWith('_PATH')) {
      out = out.split(value).join(MASK);
    }
  }
  for (const pattern of SECRET_PATTERNS) {
    out = out.replace(pattern, (match, prefix?: string) =>
      typeof prefix === 'string' && match.startsWith(prefix) ? `${prefix}${MASK}` : MASK,
    );
  }
  return out;
}

/** Diagnostics go to stderr so stdout stays machine-readable for agents. */
export const log = {
  info(message: string): void {
    process.stderr.write(`${redact(message)}\n`);
  },
  warn(message: string): void {
    process.stderr.write(`Warning: ${redact(message)}\n`);
  },
  error(message: string): void {
    process.stderr.write(`${redact(message)}\n`);
  },
};

export function printJson(value: unknown): void {
  process.stdout.write(`${redact(JSON.stringify(value, null, 2))}\n`);
}
