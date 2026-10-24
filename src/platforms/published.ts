import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { loadState, STATE_FILE } from '../shared/approval';
import { POST_FILE, type PostDraft } from '../shared/post-project';

// Finds everything this package has published under a folder by reading each project's
// state.json history, so analytics and inbox work without a separate database.

export interface PublishedItem {
  folder: string;
  platform: string;
  postId: string;
  publishedAt: string;
}

export function findPublished(root: string, maxDepth = 4): PublishedItem[] {
  const items: PublishedItem[] = [];
  const walk = (dir: string, depth: number) => {
    if (existsSync(join(dir, STATE_FILE))) {
      const history = loadState(dir).history;
      const folder = relative(root, dir) || '.';
      if (existsSync(join(dir, POST_FILE))) {
        const draft = JSON.parse(readFileSync(join(dir, POST_FILE), 'utf8')) as PostDraft;
        for (const h of history.filter((e) => e.event === 'published' && e.detail)) {
          items.push({ folder, platform: draft.platform, postId: h.detail as string, publishedAt: h.at });
        }
      }
      for (const h of history.filter((e) => e.event === 'uploaded' && e.detail)) {
        items.push({
          folder,
          platform: 'youtube',
          postId: (h.detail as string).split(' ')[0] as string,
          publishedAt: h.at,
        });
      }
    }
    if (depth >= maxDepth) return;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory() && !entry.name.startsWith('.') && entry.name !== 'node_modules')
        walk(join(dir, entry.name), depth + 1);
    }
  };
  walk(root, 0);
  return items.sort((a, b) => a.publishedAt.localeCompare(b.publishedAt));
}
