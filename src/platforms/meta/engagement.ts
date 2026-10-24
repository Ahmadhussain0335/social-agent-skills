import type { InboxComment } from '../posting';
import { loadThreadsTokens, THREADS_ENV, THREADS_GRAPH, THREADS_VERSION } from '../threads/auth';
import { loadFacebookTokens, META_ENV, type PageAccount } from './accounts';
import { GRAPH_FACEBOOK, graphVersion } from './config';
import { waitForContainer } from './containers';
import { GraphClient } from './graph';

// Read-side calls for social-analytics and social-inbox. Comments and insights need the
// permissions requested by meta-auth --with-engagement.

function pageClient(env: NodeJS.ProcessEnv, page: PageAccount): GraphClient {
  return new GraphClient({
    baseUrl: GRAPH_FACEBOOK,
    version: graphVersion(env),
    accessToken: page.accessToken,
    appSecret: env[META_ENV.appSecret],
  });
}

/** Facebook post ids look like "<pageId>_<postId>"; fall back to the only Page. */
function pageFor(env: NodeJS.ProcessEnv, objectId: string): PageAccount {
  const { pages } = loadFacebookTokens(env);
  const byPrefix = pages.find((p) => objectId.startsWith(`${p.id}_`));
  const page = byPrefix ?? (pages.length === 1 ? pages[0] : undefined);
  if (!page) throw new Error(`Cannot tell which Page owns ${objectId}; several Pages are connected.`);
  return page;
}

function igClient(env: NodeJS.ProcessEnv, mediaId: string): GraphClient {
  const { pages } = loadFacebookTokens(env);
  const page = pages.find((p) => p.instagram) ?? pages[0];
  if (!page) throw new Error(`No connected Instagram account for ${mediaId}.`);
  return pageClient(env, page);
}

function threadsClient(env: NodeJS.ProcessEnv): { client: GraphClient; userId: string } {
  const tokens = loadThreadsTokens(env);
  return {
    client: new GraphClient({
      baseUrl: THREADS_GRAPH,
      version: THREADS_VERSION,
      accessToken: tokens.accessToken,
      appSecret: env[THREADS_ENV.appSecret],
    }),
    userId: tokens.userId,
  };
}

const count = (v: unknown) => (typeof v === 'number' ? v : 0);

export async function facebookMetrics(postId: string, env: NodeJS.ProcessEnv): Promise<Record<string, number>> {
  const res = (await pageClient(env, pageFor(env, postId)).get(postId, {
    fields: 'reactions.summary(total_count).limit(0),comments.summary(total_count).limit(0),shares',
  })) as {
    reactions?: { summary?: { total_count?: number } };
    comments?: { summary?: { total_count?: number } };
    shares?: { count?: number };
  };
  return {
    reactions: count(res.reactions?.summary?.total_count),
    comments: count(res.comments?.summary?.total_count),
    shares: count(res.shares?.count),
  };
}

export async function facebookComments(postId: string, env: NodeJS.ProcessEnv): Promise<InboxComment[]> {
  const res = (await pageClient(env, pageFor(env, postId)).get(`${postId}/comments`, {
    fields: 'id,message,from{name},created_time',
    filter: 'toplevel',
    limit: 100,
  })) as { data?: Array<{ id: string; message?: string; from?: { name?: string }; created_time?: string }> };
  return (res.data ?? []).map((c) => ({
    platform: 'facebook',
    postId,
    commentId: c.id,
    author: c.from?.name ?? 'unknown',
    text: c.message ?? '',
    createdAt: c.created_time ?? '',
  }));
}

export async function facebookReply(
  comment: InboxComment,
  text: string,
  env: NodeJS.ProcessEnv,
): Promise<{ id: string }> {
  return (await pageClient(env, pageFor(env, comment.postId)).post(`${comment.commentId}/comments`, {
    message: text,
  })) as { id: string };
}

export async function instagramMetrics(mediaId: string, env: NodeJS.ProcessEnv): Promise<Record<string, number>> {
  const client = igClient(env, mediaId);
  const basic = (await client.get(mediaId, { fields: 'like_count,comments_count' })) as {
    like_count?: number;
    comments_count?: number;
  };
  const metrics: Record<string, number> = { likes: count(basic.like_count), comments: count(basic.comments_count) };
  try {
    const insights = (await client.get(`${mediaId}/insights`, { metric: 'views,reach,saved,shares' })) as {
      data?: Array<{ name: string; values?: Array<{ value?: number }>; total_value?: { value?: number } }>;
    };
    for (const m of insights.data ?? []) metrics[m.name] = count(m.total_value?.value ?? m.values?.[0]?.value);
  } catch {
    // Insights need instagram_manage_insights (meta-auth --with-engagement); counts still work.
  }
  return metrics;
}

export async function instagramComments(mediaId: string, env: NodeJS.ProcessEnv): Promise<InboxComment[]> {
  const res = (await igClient(env, mediaId).get(`${mediaId}/comments`, {
    fields: 'id,text,username,timestamp',
    limit: 100,
  })) as {
    data?: Array<{ id: string; text?: string; username?: string; timestamp?: string }>;
  };
  return (res.data ?? []).map((c) => ({
    platform: 'instagram',
    postId: mediaId,
    commentId: c.id,
    author: c.username ?? 'unknown',
    text: c.text ?? '',
    createdAt: c.timestamp ?? '',
  }));
}

export async function instagramReply(
  comment: InboxComment,
  text: string,
  env: NodeJS.ProcessEnv,
): Promise<{ id: string }> {
  return (await igClient(env, comment.postId).post(`${comment.commentId}/replies`, { message: text })) as {
    id: string;
  };
}

export async function threadsMetrics(mediaId: string, env: NodeJS.ProcessEnv): Promise<Record<string, number>> {
  const { client } = threadsClient(env);
  const res = (await client.get(`${mediaId}/insights`, { metric: 'views,likes,replies,reposts,quotes' })) as {
    data?: Array<{ name: string; values?: Array<{ value?: number }>; total_value?: { value?: number } }>;
  };
  return Object.fromEntries((res.data ?? []).map((m) => [m.name, count(m.total_value?.value ?? m.values?.[0]?.value)]));
}

export async function threadsComments(mediaId: string, env: NodeJS.ProcessEnv): Promise<InboxComment[]> {
  const { client } = threadsClient(env);
  const res = (await client.get(`${mediaId}/replies`, { fields: 'id,text,username,timestamp' })) as {
    data?: Array<{ id: string; text?: string; username?: string; timestamp?: string }>;
  };
  return (res.data ?? []).map((c) => ({
    platform: 'threads',
    postId: mediaId,
    commentId: c.id,
    author: c.username ?? 'unknown',
    text: c.text ?? '',
    createdAt: c.timestamp ?? '',
  }));
}

export async function threadsReply(
  comment: InboxComment,
  text: string,
  env: NodeJS.ProcessEnv,
  sleep?: (ms: number) => Promise<void>,
): Promise<{ id: string }> {
  const { client, userId } = threadsClient(env);
  const { id: containerId } = (await client.post(`${userId}/threads`, {
    media_type: 'TEXT',
    text,
    reply_to_id: comment.commentId,
  })) as { id: string };
  await waitForContainer(client, containerId, { field: 'status', sleep, firstDelayMs: 1_000 });
  return (await client.post(`${userId}/threads_publish`, { creation_id: containerId })) as { id: string };
}
