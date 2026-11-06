import type { PostDraft } from '../shared/post-project';

// Notes shown to the user at approval time. Kept free of API clients so the social-core
// approval script stays small and does not bundle every platform.

// Posting is pay-per-use; prices checked 2026-10-24 at https://docs.x.com/x-api/getting-started/pricing
export const X_PRICES = { checkedOn: '2026-10-24', post: 0.015, postWithUrl: 0.2, currency: 'USD' } as const;

// No /g flag: RegExp.test with /g keeps lastIndex between calls and alternates results.
const HAS_URL = /https?:\/\/\S+/;

export function xCost(draft: PostDraft): number {
  return HAS_URL.test(draft.text ?? '') || draft.link ? X_PRICES.postWithUrl : X_PRICES.post;
}

export function xApprovalNotes(draft: PostDraft): string[] {
  return [`Estimated X API cost: $${xCost(draft)} (X price list checked ${X_PRICES.checkedOn}).`];
}

export function tiktokApprovalNotes(draft: PostDraft): string[] {
  if (draft.options?.mode !== 'direct') {
    return ['Draft mode: the video goes to your TikTok inbox; nothing is public until you post it in the app.'];
  }
  return [
    `Posting as ${draft.options?.creatorNickname} with privacy ${draft.options?.privacyLevel}.`,
    draft.options?.brandedContent
      ? "By posting, you agree to TikTok's Branded Content Policy and Music Usage Confirmation."
      : "By posting, you agree to TikTok's Music Usage Confirmation.",
  ];
}

export function approvalNotes(draft: PostDraft): string[] {
  switch (draft.platform) {
    case 'x':
      return xApprovalNotes(draft);
    case 'tiktok':
      return tiktokApprovalNotes(draft);
    default:
      return [];
  }
}
