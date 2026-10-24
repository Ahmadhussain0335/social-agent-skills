/** An error with a stable code and a hint the user can act on. */
export class PlatformError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly hint?: string,
    readonly docsUrl?: string,
  ) {
    super(message);
    this.name = 'PlatformError';
  }
}

export function formatError(error: unknown): string {
  if (error instanceof PlatformError) {
    const lines = [`Error [${error.code}]: ${error.message}`];
    if (error.hint) lines.push(`Hint: ${error.hint}`);
    if (error.docsUrl) lines.push(`Docs: ${error.docsUrl}`);
    return lines.join('\n');
  }
  return `Error: ${error instanceof Error ? error.message : String(error)}`;
}
