import type { PostDraft } from '../shared/post-project';
import type { CheckResult } from './meta/facebook';

// Single-post platforms share one contract so cross-platform skills (repurpose, calendar,
// analytics) can validate and publish any of them the same way. YouTube is not here: it
// goes through its own three-checkpoint pipeline.

export interface PostPlatform {
  id: string;
  label: string;
  kinds: readonly string[];
  /** Main text limit in the platform's own counting, for drafting guidance. */
  textLimit: number;
  /** Whether the API supports scheduling (scheduledAt in post.json). */
  scheduling: boolean;
  /** Short notes an agent should know when drafting for this platform. */
  notes: readonly string[];
  check(draft: PostDraft, now?: number): CheckResult;
  /** Extra lines shown to the user at approval (costs, platform declarations). */
  approvalNotes?(draft: PostDraft): string[];
  publish(dir: string, draft: PostDraft, env: NodeJS.ProcessEnv): Promise<Record<string, unknown>>;
  /** Public engagement counts for a published post (socialkit-social-analytics). */
  metrics?(postId: string, env: NodeJS.ProcessEnv): Promise<Record<string, number>>;
  /** Comments or replies on a published post (socialkit-social-inbox). */
  comments?(postId: string, env: NodeJS.ProcessEnv): Promise<InboxComment[]>;
  /** Replies to a comment after the user approved the reply text (socialkit-social-inbox). */
  reply?(comment: InboxComment, text: string, env: NodeJS.ProcessEnv): Promise<{ id: string }>;
}

export interface InboxComment {
  platform: string;
  postId: string;
  commentId: string;
  author: string;
  text: string;
  createdAt: string;
}

const registry = new Map<string, PostPlatform>();

export function registerPostPlatform(platform: PostPlatform): void {
  registry.set(platform.id, platform);
}

export function postPlatform(id: string): PostPlatform {
  const platform = registry.get(id);
  if (!platform) {
    throw new Error(`Unknown posting platform "${id}". Available: ${[...registry.keys()].join(', ')}`);
  }
  return platform;
}

export function postPlatforms(): PostPlatform[] {
  return [...registry.values()];
}
