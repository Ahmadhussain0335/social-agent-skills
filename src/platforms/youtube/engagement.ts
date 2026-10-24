import type { InboxComment } from '../posting';
import { apiKeyClient } from './client';
import { spendQuota } from './config';
import { toYouTubeError } from './errors';

// Public statistics and comments through the research API key; replying on YouTube needs
// an additional OAuth scope and is not offered.

export async function youtubeMetrics(
  videoId: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<Record<string, number>> {
  try {
    spendQuota('videos.list', env);
    const res = await apiKeyClient(env).videos.list({ part: ['statistics'], id: [videoId] });
    const s = res.data.items?.[0]?.statistics ?? {};
    return { views: Number(s.viewCount ?? 0), likes: Number(s.likeCount ?? 0), comments: Number(s.commentCount ?? 0) };
  } catch (error) {
    throw toYouTubeError(error);
  }
}

export async function youtubeComments(videoId: string, env: NodeJS.ProcessEnv = process.env): Promise<InboxComment[]> {
  try {
    spendQuota('videos.list', env);
    const res = await apiKeyClient(env).commentThreads.list({
      part: ['snippet'],
      videoId,
      maxResults: 100,
      order: 'time',
    });
    return (res.data.items ?? []).map((t) => {
      const c = t.snippet?.topLevelComment?.snippet;
      return {
        platform: 'youtube',
        postId: videoId,
        commentId: t.snippet?.topLevelComment?.id ?? t.id ?? '',
        author: c?.authorDisplayName ?? 'unknown',
        text: c?.textOriginal ?? '',
        createdAt: c?.publishedAt ?? '',
      };
    });
  } catch (error) {
    throw toYouTubeError(error);
  }
}
