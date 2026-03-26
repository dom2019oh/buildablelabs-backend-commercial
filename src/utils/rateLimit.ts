// =============================================================================
// Simple in-memory sliding-window rate limiter
// No external deps — uses a Map<userId, timestamp[]>
// =============================================================================

type RateLimitConfig = {
  windowMs: number;   // window length in ms
  maxRequests: number; // max requests per window per user
};

function createLimiter(config: RateLimitConfig) {
  // Map<userId, sorted list of request timestamps>
  const windows = new Map<string, number[]>();

  // Prune the map periodically to avoid unbounded growth
  setInterval(() => {
    const cutoff = Date.now() - config.windowMs;
    for (const [uid, timestamps] of windows) {
      const filtered = timestamps.filter(t => t > cutoff);
      if (filtered.length === 0) {
        windows.delete(uid);
      } else {
        windows.set(uid, filtered);
      }
    }
  }, config.windowMs);

  return function rateLimitMiddleware(userId: string): { allowed: boolean; retryAfterMs: number } {
    const now = Date.now();
    const cutoff = now - config.windowMs;
    const prev = (windows.get(userId) ?? []).filter(t => t > cutoff);

    if (prev.length >= config.maxRequests) {
      const oldestInWindow = prev[0];
      const retryAfterMs = oldestInWindow + config.windowMs - now;
      return { allowed: false, retryAfterMs };
    }

    prev.push(now);
    windows.set(userId, prev);
    return { allowed: true, retryAfterMs: 0 };
  };
}

// Generate: max 10 requests per minute per user
export const generateRateLimit = createLimiter({ windowMs: 60_000, maxRequests: 10 });

// Credits claim: max 5 requests per minute per user (already server-enforced to once/day, but stops hammering)
export const claimRateLimit = createLimiter({ windowMs: 60_000, maxRequests: 5 });
