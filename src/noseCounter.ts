export const NOSE_COUNTER_COOLDOWN_MS = 2_000;

export function noseCounterWaitRemainingMs(now: number, waitUntil: number) {
  if (!Number.isFinite(now) || !Number.isFinite(waitUntil)) return 0;
  return Math.max(0, Math.ceil(waitUntil - now));
}
