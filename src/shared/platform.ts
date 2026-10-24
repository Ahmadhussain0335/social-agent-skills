/** Contract each platform module implements so the CLI (doctor) and skills share one source of truth. */
export interface EnvVarSpec {
  name: string;
  required: boolean;
  description: string;
  /** Path vars are checked for existence and file mode instead of being masked. */
  kind: 'path' | 'secret' | 'value';
}

export interface Check {
  name: string;
  status: 'ok' | 'warn' | 'fail';
  detail: string;
}

export interface Platform {
  id: string;
  label: string;
  /** Skills that belong to this platform. */
  skills: readonly string[];
  env: readonly EnvVarSpec[];
  /** Account or review constraints surfaced in errors and docs. */
  knownLimits: readonly string[];
  doctor(env: NodeJS.ProcessEnv): Check[];
}
