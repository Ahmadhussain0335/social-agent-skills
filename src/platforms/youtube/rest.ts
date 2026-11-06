import { openAsBlob, statSync } from 'node:fs';
import { fetchWithRetry } from '../../shared/http';

// Minimal YouTube Data API v3 client over fetch. It mirrors the method shapes this package
// uses (videos.insert/list, thumbnails.set, search.list, commentThreads.list) so callers
// stay simple, without bundling Google's client libraries.
// https://developers.google.com/youtube/v3/docs

const API = 'https://www.googleapis.com/youtube/v3';
const UPLOAD = 'https://www.googleapis.com/upload/youtube/v3';

export interface VideoResource {
  id?: string;
  snippet?: { title?: string; channelTitle?: string; publishedAt?: string; tags?: string[] };
  status?: { privacyStatus?: string };
  statistics?: { viewCount?: string; likeCount?: string; commentCount?: string };
  contentDetails?: { duration?: string };
}

export interface CommentThread {
  id?: string;
  snippet?: {
    topLevelComment?: {
      id?: string;
      snippet?: { authorDisplayName?: string; textOriginal?: string; publishedAt?: string };
    };
  };
}

export interface InsertParams {
  part: string[];
  notifySubscribers?: boolean;
  requestBody: Record<string, unknown>;
  media: { path: string; mimeType?: string };
}

export interface YouTubeApi {
  videos: {
    insert(p: InsertParams): Promise<{ data: VideoResource }>;
    list(p: { part: string[]; id: string[] }): Promise<{ data: { items?: VideoResource[] } }>;
  };
  thumbnails: { set(p: { videoId: string; media: { mimeType: string; path: string } }): Promise<{ data: unknown }> };
  search: {
    list(p: {
      part: string[];
      q: string;
      type: string[];
      maxResults: number;
      order: string;
      publishedAfter?: string;
      regionCode?: string;
      relevanceLanguage?: string;
    }): Promise<{ data: { items?: Array<{ id?: { videoId?: string } }> } }>;
  };
  commentThreads: {
    list(p: { part: string[]; videoId: string; maxResults: number; order: string }): Promise<{
      data: { items?: CommentThread[] };
    }>;
  };
}

/** Bearer token (OAuth) or API key, sent as a header so keys never appear in URLs or logs. */
export type YouTubeAuth = { bearer: () => Promise<string> } | { apiKey: string };

/** Error carrying Google's reason (quotaExceeded, ...) where youtube/errors.ts looks for it. */
async function apiError(res: Response): Promise<Error> {
  const body = (await res.json().catch(() => ({}))) as { error?: { message?: string; errors?: unknown[] } };
  const error = new Error(body.error?.message ?? `YouTube API HTTP ${res.status}`) as Error & {
    response?: unknown;
    errors?: unknown[];
  };
  error.response = { status: res.status, data: { error: body.error } };
  error.errors = body.error?.errors;
  return error;
}

function query(params: Record<string, string | number | boolean | string[] | undefined>): string {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined) continue;
    q.set(k, Array.isArray(v) ? v.join(',') : String(v));
  }
  return q.toString();
}

export function youtubeRest(auth: YouTubeAuth, fetchImpl: typeof fetch = fetch): YouTubeApi {
  const headers = async (extra: Record<string, string> = {}): Promise<Record<string, string>> => ({
    accept: 'application/json',
    ...('apiKey' in auth ? { 'x-goog-api-key': auth.apiKey } : { authorization: `Bearer ${await auth.bearer()}` }),
    ...extra,
  });

  const get = async <T>(
    path: string,
    params: Record<string, string | number | string[] | undefined>,
  ): Promise<{ data: T }> => {
    const res = await fetchWithRetry(`${API}${path}?${query(params)}`, { headers: await headers() }, { fetchImpl });
    if (!res.ok) throw await apiError(res);
    return { data: (await res.json()) as T };
  };

  return {
    videos: {
      async insert(p) {
        // Resumable upload: send the metadata first; YouTube answers with the URL for the file.
        const size = statSync(p.media.path).size;
        const start = await fetchImpl(
          `${UPLOAD}/videos?${query({ uploadType: 'resumable', part: p.part, notifySubscribers: p.notifySubscribers })}`,
          {
            method: 'POST',
            headers: await headers({
              'content-type': 'application/json; charset=UTF-8',
              'x-upload-content-type': p.media.mimeType ?? 'video/*',
              'x-upload-content-length': String(size),
            }),
            body: JSON.stringify(p.requestBody),
          },
        );
        if (!start.ok) throw await apiError(start);
        const uploadUrl = start.headers.get('location');
        if (!uploadUrl) throw new Error('YouTube did not return a resumable upload URL.');
        const res = await fetchImpl(uploadUrl, {
          method: 'PUT',
          headers: await headers({ 'content-type': p.media.mimeType ?? 'video/*' }),
          body: await openAsBlob(p.media.path),
        });
        if (!res.ok) throw await apiError(res);
        return { data: (await res.json()) as VideoResource };
      },
      list: (p) => get<{ items?: VideoResource[] }>('/videos', { part: p.part, id: p.id }),
    },
    thumbnails: {
      async set(p) {
        const res = await fetchImpl(`${UPLOAD}/thumbnails/set?${query({ videoId: p.videoId, uploadType: 'media' })}`, {
          method: 'POST',
          headers: await headers({ 'content-type': p.media.mimeType }),
          body: await openAsBlob(p.media.path),
        });
        if (!res.ok) throw await apiError(res);
        return { data: await res.json() };
      },
    },
    search: { list: (p) => get('/search', { ...p }) },
    commentThreads: { list: (p) => get('/commentThreads', { ...p }) },
  };
}
