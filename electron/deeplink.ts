import type { DeepLink } from './shared';

export const SCHEME = 'tailscale-manager';

/** tailscale-manager://upload?file=...&server=... 형식을 읽는다 */
export function parseDeepLink(url: string): DeepLink | null {
  if (!url.startsWith(`${SCHEME}://`)) return null;
  try {
    const u = new URL(url);
    const params: Record<string, string> = {};
    u.searchParams.forEach((v, k) => (params[k] = v));
    return { action: u.hostname || u.pathname.replace(/^\/+/, ''), params };
  } catch {
    return null;
  }
}

export function findDeepLinkArg(argv: string[]): string | undefined {
  return argv.find((a) => a.startsWith(`${SCHEME}://`));
}
