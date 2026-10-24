import type { Platform } from '../shared/platform';
import { youtubePlatform } from './youtube';

/** Add each new platform here; doctor and docs read from this list. */
export const PLATFORMS: readonly Platform[] = [youtubePlatform];
