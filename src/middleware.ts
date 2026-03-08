import type { Context, Next } from 'hono';
import type { Env } from './types';

/**
 * Bearer token middleware for all standard HTTP endpoints.
 * Reads:  Authorization: Bearer <API_SECRET>
 */
export async function authMiddleware(
  c: Context<{ Bindings: Env }>,
  next: Next,
): Promise<Response | void> {
  const header = c.req.header('Authorization') ?? '';

  if (!header.startsWith('Bearer ')) {
    return c.json({ error: 'Unauthorized' }, 401);
  }

  if (header.slice(7) !== c.env.API_SECRET) {
    return c.json({ error: 'Forbidden' }, 403);
  }

  await next();
}

/**
 * WebSocket connections cannot easily set custom headers from all clients,
 * so we accept the secret as a URL query param for the /ws/* route only.
 * HTTPS encrypts query params in transit, so this is safe for personal use.
 */
export function validateWsSecret(secret: string | undefined, apiSecret: string): boolean {
  return !!secret && secret === apiSecret;
}