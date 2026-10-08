import { execFile } from 'node:child_process';
import fs from 'node:fs';
import type { TailscalePeer, TailscaleStatus } from '../shared';

/** OS별로 tailscale CLI가 있을 만한 위치 (앞쪽이 우선) */
export function cliCandidates(platform: NodeJS.Platform): string[] {
  if (platform === 'darwin') {
    return [
      '/usr/local/bin/tailscale',
      '/opt/homebrew/bin/tailscale',
      '/Applications/Tailscale.app/Contents/MacOS/Tailscale',
    ];
  }
  if (platform === 'win32') {
    return [
      'C:\\Program Files\\Tailscale\\tailscale.exe',
      'C:\\Program Files (x86)\\Tailscale\\tailscale.exe',
    ];
  }
  return ['/usr/bin/tailscale', '/usr/local/bin/tailscale'];
}

export function findCli(platform = process.platform, exists = fs.existsSync): string | null {
  return cliCandidates(platform).find((p) => exists(p)) ?? null;
}

interface RawPeer {
  HostName?: string;
  DNSName?: string;
  TailscaleIPs?: string[];
  OS?: string;
  Online?: boolean;
  LastSeen?: string;
}

function toPeer(p: RawPeer, self: boolean): TailscalePeer {
  // Tailscale은 접속 기록이 없으면 0001-01-01을 준다
  const lastSeen = p.LastSeen && !p.LastSeen.startsWith('0001') ? p.LastSeen : null;
  return {
    name: p.HostName ?? '',
    dnsName: (p.DNSName ?? '').replace(/\.$/, ''),
    ips: p.TailscaleIPs ?? [],
    os: p.OS ?? '',
    online: self ? true : Boolean(p.Online),
    lastSeen,
    self,
  };
}

/** `tailscale status --json` 출력을 화면용 형태로 바꾼다 */
export function parseStatus(json: string, cliPath: string | null): TailscaleStatus {
  const raw = JSON.parse(json) as { BackendState?: string; Self?: RawPeer; Peer?: Record<string, RawPeer> };
  const backendState = raw.BackendState ?? 'Unknown';
  const peers = Object.values(raw.Peer ?? {})
    .map((p) => toPeer(p, false))
    .sort((a, b) => Number(b.online) - Number(a.online) || a.name.localeCompare(b.name));
  return {
    installed: true,
    cliPath,
    backendState,
    running: backendState === 'Running',
    self: raw.Self ? toPeer(raw.Self, true) : null,
    peers,
  };
}

function run(cli: string, args: string[], timeoutMs = 20000): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve) => {
    execFile(cli, args, { timeout: timeoutMs, windowsHide: true }, (err, stdout, stderr) => {
      const code = err ? (typeof (err as NodeJS.ErrnoException).code === 'number' ? Number((err as NodeJS.ErrnoException).code) : 1) : 0;
      resolve({ stdout: String(stdout), stderr: String(stderr) || (err && !stderr ? err.message : ''), code });
    });
  });
}

const notInstalled: TailscaleStatus = {
  installed: false,
  cliPath: null,
  backendState: 'NotInstalled',
  running: false,
  self: null,
  peers: [],
  error: 'Tailscale이 설치되어 있지 않거나 명령줄 도구를 찾지 못했습니다.',
};

export async function getStatus(cli = findCli()): Promise<TailscaleStatus> {
  if (!cli) return notInstalled;
  const r = await run(cli, ['status', '--json']);
  // 꺼져 있을 때도 JSON은 나오고 종료 코드만 1이다
  try {
    return parseStatus(r.stdout, cli);
  } catch {
    return { ...notInstalled, installed: true, cliPath: cli, backendState: 'Unknown', error: r.stderr.trim() || 'Tailscale 상태를 읽지 못했습니다.' };
  }
}

export async function setRunning(on: boolean, cli = findCli()): Promise<TailscaleStatus> {
  if (!cli) throw new Error(notInstalled.error);
  const r = await run(cli, [on ? 'up' : 'down'], 30000);
  if (r.code !== 0) {
    const msg = r.stderr.trim();
    if (/login|auth/i.test(msg)) throw new Error('Tailscale 로그인이 필요합니다. Tailscale 앱에서 먼저 로그인하세요.');
    throw new Error(msg || `tailscale ${on ? 'up' : 'down'} 실패`);
  }
  return getStatus(cli);
}
