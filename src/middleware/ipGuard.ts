// =============================================================================
// IP Guard Middleware
// Multi-layer VPN / proxy / bot detection for generate and init endpoints.
//
// Layer 1: Cloudflare threat score (CF-Threat-Score > 50 → block)
// Layer 2: Tor exit node (CF-IPCountry: T1 → block)
// Layer 3: ip-api.com reputation — proxy/hosting flag (24h cache)
// Layer 4: Generic brute-force rate limit (ipApiLimit)
//
// Fail-open: if ip-api.com is unreachable, the request is allowed through.
// =============================================================================

import type { Context, Next } from 'hono';
import { ipApiLimit } from '../utils/rateLimit';
import { logger } from '../utils/logger';

// In-memory IP reputation cache  { ip → { blocked, cachedAt } }
const ipCache = new Map<string, { blocked: boolean; cachedAt: number }>();
const CACHE_TTL_MS = 24 * 60 * 60_000; // 24 hours

function getClientIp(c: Context): string {
  // Cloudflare sets CF-Connecting-IP to the real client IP, even behind proxies
  return (
    c.req.header('cf-connecting-ip') ??
    c.req.header('x-forwarded-for')?.split(',')[0]?.trim() ??
    'unknown'
  );
}

async function checkIpReputation(ip: string): Promise<boolean> {
  const cached = ipCache.get(ip);
  if (cached && Date.now() - cached.cachedAt < CACHE_TTL_MS) {
    return cached.blocked;
  }

  // Skip check for private/local IPs (dev environment)
  if (
    ip === 'unknown' ||
    ip.startsWith('127.') ||
    ip.startsWith('10.') ||
    ip.startsWith('192.168.') ||
    ip === '::1' ||
    ip.startsWith('fc') ||
    ip.startsWith('fd')
  ) {
    return false;
  }

  try {
    const res = await fetch(
      `http://ip-api.com/json/${ip}?fields=status,proxy,hosting`,
      { signal: AbortSignal.timeout(3000) },
    );
    if (!res.ok) return false; // fail-open

    const data = await res.json() as { status: string; proxy?: boolean; hosting?: boolean };
    const blocked = data.status === 'success' && (data.proxy === true || data.hosting === true);

    ipCache.set(ip, { blocked, cachedAt: Date.now() });

    // Prune cache when it gets large
    if (ipCache.size > 50_000) {
      const cutoff = Date.now() - CACHE_TTL_MS;
      for (const [k, v] of ipCache) {
        if (v.cachedAt < cutoff) ipCache.delete(k);
      }
    }

    return blocked;
  } catch {
    // ip-api.com unreachable — fail open, never block a legit user
    return false;
  }
}

export async function ipGuard(c: Context, next: Next) {
  const ip = getClientIp(c);

  // Layer 1: Cloudflare threat score
  const threatScore = parseInt(c.req.header('cf-threat-score') ?? '0', 10);
  if (threatScore > 50) {
    logger.warn({ ip, threatScore }, 'ipGuard: blocked high CF threat score');
    return c.json({ error: 'Request blocked.' }, 403);
  }

  // Layer 2: Tor exit node
  if (c.req.header('cf-ipcountry') === 'T1') {
    logger.warn({ ip }, 'ipGuard: blocked Tor exit node');
    return c.json({ error: 'Request blocked.' }, 403);
  }

  // Layer 3: Generic brute-force IP rate limit
  const rl = ipApiLimit(ip);
  if (!rl.allowed) {
    return c.json({ error: 'Too many requests from your network.', retryAfterMs: rl.retryAfterMs }, 429);
  }

  // Layer 4: VPN/proxy/datacenter reputation check (cached 24h, fail-open)
  const isBlocked = await checkIpReputation(ip);
  if (isBlocked) {
    logger.warn({ ip }, 'ipGuard: blocked VPN/datacenter IP');
    return c.json({ error: 'This network is not permitted. Please use a residential connection.' }, 403);
  }

  await next();
}

// Lightweight variant for account init — adds per-IP daily new-account throttle
export { getClientIp };
