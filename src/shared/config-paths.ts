import { homedir } from 'node:os';
import { join } from 'node:path';

const APP = 'social-skills';

/**
 * Per-user config directory for tokens, quota ledgers and backups. Never inside a project.
 * Override with SOCIAL_SKILLS_CONFIG_DIR.
 */
export function configDir(env: NodeJS.ProcessEnv = process.env): string {
  if (env.SOCIAL_SKILLS_CONFIG_DIR) return env.SOCIAL_SKILLS_CONFIG_DIR;
  if (process.platform === 'win32' && env.APPDATA) return join(env.APPDATA, APP);
  const xdg = env.XDG_CONFIG_HOME;
  return join(xdg && xdg.length > 0 ? xdg : join(homedir(), '.config'), APP);
}

export function platformDir(platform: string, env: NodeJS.ProcessEnv = process.env): string {
  return join(configDir(env), platform);
}
