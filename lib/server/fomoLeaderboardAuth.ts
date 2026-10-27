import { canAccessFomoBoard } from "@/lib/planFeatures";

export const FOMO_BOARD_ELITE_REQUIRED = {
  error: "elite_required",
  message: "FOMO Board requires Elite.",
} as const;

export function authorizeFomoLeaderboardRequest(plan: string | null | undefined):
  | { allowed: true }
  | { allowed: false; status: 403; body: typeof FOMO_BOARD_ELITE_REQUIRED } {
  if (canAccessFomoBoard(plan)) return { allowed: true };
  return { allowed: false, status: 403, body: FOMO_BOARD_ELITE_REQUIRED };
}
