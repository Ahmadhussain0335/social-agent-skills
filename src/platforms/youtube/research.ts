import type { youtube_v3 } from '@googleapis/youtube';
import { spendQuota } from './config';
import { toYouTubeError } from './errors';

export interface ResearchQuery {
  query: string;
  max?: number;
  order?: 'relevance' | 'viewCount' | 'date' | 'rating';
  publishedAfter?: string;
  regionCode?: string;
  language?: string;
}

export interface ResearchVideo {
  videoId: string;
  url: string;
  title: string;
  channelTitle: string;
  publishedAt: string;
  duration: string;
  views: number;
  likes: number;
  comments: number;
  tags: string[];
}

/** One search.list call (search bucket) plus one videos.list call for statistics. */
export async function researchVideos(
  api: Pick<youtube_v3.Youtube, 'search' | 'videos'>,
  q: ResearchQuery,
  env: NodeJS.ProcessEnv = process.env,
): Promise<ResearchVideo[]> {
  try {
    spendQuota('search.list', env);
    const search = await api.search.list({
      part: ['snippet'],
      q: q.query,
      type: ['video'],
      maxResults: Math.min(Math.max(q.max ?? 10, 1), 50),
      order: q.order ?? 'relevance',
      publishedAfter: q.publishedAfter,
      regionCode: q.regionCode,
      relevanceLanguage: q.language,
    });
    const ids = (search.data.items ?? []).map((item) => item.id?.videoId).filter((id): id is string => Boolean(id));
    if (ids.length === 0) return [];

    spendQuota('videos.list', env);
    const details = await api.videos.list({ part: ['snippet', 'statistics', 'contentDetails'], id: ids });
    return (details.data.items ?? []).map((v) => ({
      videoId: v.id ?? '',
      url: `https://www.youtube.com/watch?v=${v.id}`,
      title: v.snippet?.title ?? '',
      channelTitle: v.snippet?.channelTitle ?? '',
      publishedAt: v.snippet?.publishedAt ?? '',
      duration: v.contentDetails?.duration ?? '',
      views: Number(v.statistics?.viewCount ?? 0),
      likes: Number(v.statistics?.likeCount ?? 0),
      comments: Number(v.statistics?.commentCount ?? 0),
      tags: v.snippet?.tags ?? [],
    }));
  } catch (error) {
    throw toYouTubeError(error);
  }
}
