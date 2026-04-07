// =============================================================================
// In-memory sliding-window rate limiters
// No external deps — Map<key, timestamp[]> per limiter instance
// =============================================================================

type RateLimitConfig = {
  windowMs: number;
  maxRequests: number;
};

function createLimiter(config: RateLimitConfig) {
  const windows = new Map<string, number[]>();

  // Prune stale entries periodically
  setInterval(() => {
    const cutoff = Date.now() - config.windowMs;
    for (const [key, timestamps] of windows) {
      const filtered = timestamps.filter(t => t > cutoff);
      if (filtered.length === 0) windows.delete(key);
      else windows.set(key, filtered);
    }
  }, config.windowMs);

  return function check(key: string): { allowed: boolean; retryAfterMs: number } {
    const now = Date.now();
    const cutoff = now - config.windowMs;
    const prev = (windows.get(key) ?? []).filter(t => t > cutoff);

    if (prev.length >= config.maxRequests) {
      const retryAfterMs = prev[0] + config.windowMs - now;
      return { allowed: false, retryAfterMs };
    }

    prev.push(now);
    windows.set(key, prev);
    return { allowed: true, retryAfterMs: 0 };
  };
}

// Per-user limiters
export const generateRateLimit   = createLimiter({ windowMs: 60_000,           maxRequests: 10 }); // 10/min per user
export const claimRateLimit      = createLimiter({ windowMs: 60_000,           maxRequests: 5  }); // 5/min per user
export const freeTierHourlyLimit = createLimiter({ windowMs: 60 * 60_000,      maxRequests: 3  }); // 3 builds/hr free
export const chatRateLimit       = createLimiter({ windowMs: 60_000,           maxRequests: 30 }); // 30 chat msgs/min per user

// Per-IP limiters
export const ipGenerateLimit     = createLimiter({ windowMs: 60 * 60_000,      maxRequests: 5  }); // 5 builds/hr per IP
export const ipInitLimit         = createLimiter({ windowMs: 24 * 60 * 60_000, maxRequests: 3  }); // 3 new accounts/day per IP
export const ipApiLimit          = createLimiter({ windowMs: 60_000,           maxRequests: 120 }); // 120 req/min per IP (generate guard)
export const ipGlobalLimit       = createLimiter({ windowMs: 60_000,           maxRequests: 300 }); // 300 req/min per IP (global brute-force guard)
