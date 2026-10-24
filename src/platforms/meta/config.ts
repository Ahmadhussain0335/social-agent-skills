// Graph API version for graph.facebook.com (WhatsApp, Facebook Pages, Instagram with Facebook Login).
// v26.0 released 2026-07-29 per https://developers.facebook.com/docs/graph-api/changelog
// Override with META_GRAPH_VERSION to test a newer version without a release.
export const DEFAULT_GRAPH_VERSION = 'v26.0';

export function graphVersion(env: NodeJS.ProcessEnv = process.env): string {
  const v = env.META_GRAPH_VERSION;
  return v && /^v\d+\.\d+$/.test(v) ? v : DEFAULT_GRAPH_VERSION;
}

export const GRAPH_FACEBOOK = 'https://graph.facebook.com';
