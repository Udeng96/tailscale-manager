import path from 'node:path';
import type { AppConfig, CheckStep } from '../shared';
import { HostKeyStore } from './hostKeys';
import { KeyStore, linuxInstallCommand, windowsInstallCommand } from './keys';
import { probePostgres } from './pgProbe';
import { connectSsh, exec, forwardOut, SshError } from './ssh';
import { getStatus } from './tailscale';
import { TunnelManager } from './tunnels';
import type { TailscaleStatus } from '../shared';

/** Electron 없이도 테스트할 수 있도록 기능을 한곳에 모은 것 */
export class Services {
  readonly hostKeys: HostKeyStore;
  readonly keys: KeyStore;
  readonly tunnels: TunnelManager;

  constructor(
    dataDir: string,
    public getConfig: () => AppConfig,
    private tailscaleStatus: () => Promise<TailscaleStatus> = () => getStatus(),
    sshKnownHosts?: string,
  ) {
    this.hostKeys = new HostKeyStore(path.join(dataDir, 'known_hosts.json'), sshKnownHosts);
    this.keys = new KeyStore(path.join(dataDir, 'keys'));
    this.tunnels = new TunnelManager(getConfig, this.hostKeys, () => this.keys.privateKey());
  }

  /** DB 연결 테스트: Tailscale → 경유지 → 터널 → PostgreSQL 순서로 확인 */
  async checkDb(id: string): Promise<CheckStep[]> {
    const config = this.getConfig();
    const t = config.tunnels.find((x) => x.id === id);
    if (!t) return [{ label: '연결 설정', ok: false, detail: '없는 연결입니다.' }];
    const steps: CheckStep[] = [];

    const ts = await this.tailscaleStatus();
    steps.push({
      label: '내 PC Tailscale',
      ok: ts.running,
      detail: ts.running ? `켜짐 (${ts.self?.ips[0] ?? ''})` : (ts.error ?? `꺼짐 (${ts.backendState})`),
    });
    if (!ts.running) return steps;

    const gwPeer = ts.peers.find((p) => p.ips.includes(config.gateway.host) || p.name === config.gateway.host);
    if (gwPeer) {
      steps.push({
        label: '경유지 PC',
        ok: gwPeer.online,
        detail: gwPeer.online ? `${gwPeer.name} 온라인` : `${gwPeer.name} 오프라인 (Tailscale이 꺼져 있거나 PC가 꺼져 있음)`,
      });
      if (!gwPeer.online) return steps;
    }

    const open = this.tunnels.isOpen(id);
    steps.push({
      label: '터널',
      ok: open,
      detail: open ? `127.0.0.1:${t.local} → ${t.host}:${t.port}` : '연결되어 있지 않습니다. 먼저 "연결"을 누르세요.',
    });
    // 터널이 없어도 다른 프로그램(기존 울산 연결 앱 등)이 같은 포트를 열어 뒀을 수 있으니 DB 응답은 확인한다
    const pg = await probePostgres('127.0.0.1', t.local);
    steps.push({
      label: 'PostgreSQL 응답',
      ok: pg.ok,
      detail: pg.ok ? `응답함${pg.ssl ? ' (SSL 지원)' : ''}${open ? '' : ' — 다른 프로그램이 연 터널로 응답'}` : pg.reason,
    });
    return steps;
  }

  /** target: 'gateway' 또는 ssh 종류 터널 id */
  async installKey(target: string, password: string): Promise<string> {
    const pub = this.keys.status().publicKey ?? this.keys.generate().publicKey!;
    const config = this.getConfig();

    if (target === 'gateway') {
      const gw = config.gateway;
      const client = await connectSsh(
        { label: gw.name || '경유지', host: gw.host, port: gw.port, user: gw.user, password },
        this.hostKeys,
      );
      try {
        const r = await exec(client, windowsInstallCommand(pub));
        if (!/^(ADDED|EXISTS)/m.test(r.stdout)) throw new Error(`키 등록 실패: ${(r.stderr || r.stdout).trim()}`);
        return r.stdout.includes('EXISTS') ? '이미 등록된 키입니다.' : '키를 등록했습니다. 다음부터 비밀번호 없이 연결됩니다.';
      } finally {
        client.end();
      }
    }

    const t = config.tunnels.find((x) => x.id === target && x.kind === 'ssh');
    if (!t) throw new SshError('UNKNOWN', 'SSH 서버가 아닙니다.');
    if (!this.tunnels.snapshot().gateway.connected) {
      throw new SshError('UNKNOWN', '먼저 경유지에 연결하세요 (아무 연결이나 "연결"을 누르면 됩니다).');
    }
    const gwClient = await this.tunnels.gateway();
    const sock = await forwardOut(gwClient, t.host, t.port);
    const client = await connectSsh({ label: t.name, host: t.host, port: t.port, user: t.user, password, sock }, this.hostKeys);
    try {
      const r = await exec(client, linuxInstallCommand(pub));
      if (r.code !== 0) throw new Error(`키 등록 실패: ${(r.stderr || r.stdout).trim()}`);
      return r.stdout.includes('EXISTS') ? '이미 등록된 키입니다.' : '키를 등록했습니다.';
    } finally {
      client.end();
    }
  }
}
