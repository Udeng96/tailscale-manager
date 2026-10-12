import { EventEmitter } from 'node:events';
import net from 'node:net';
import type { Client } from 'ssh2';
import type { AppConfig, GatewayState, Tunnel, TunnelState } from '../shared';
import type { HostKeyStore } from './hostKeys';
import { connectSsh, forwardOut, SshError } from './ssh';

interface OpenTunnel {
  server: net.Server;
  sockets: Set<net.Socket>;
}

export interface TunnelSnapshot {
  gateway: GatewayState;
  tunnels: TunnelState[];
}

/**
 * 경유지(울산 Windows PC)에 SSH 연결 하나를 열어 두고,
 * 그 연결 위에 127.0.0.1:local → host:port 포워딩을 여러 개 연다. (ssh -L 과 같은 동작)
 */
export class TunnelManager extends EventEmitter {
  private gw: Client | null = null;
  private gwPending: Promise<Client> | null = null;
  private gwMessage: string | undefined;
  private open = new Map<string, OpenTunnel>();
  private states = new Map<string, TunnelState>();

  constructor(
    private getConfig: () => AppConfig,
    private hostKeys: HostKeyStore,
    private getPrivateKey: () => string | undefined,
  ) {
    super();
  }

  snapshot(): TunnelSnapshot {
    return {
      gateway: { connected: this.gw !== null, message: this.gwMessage },
      tunnels: this.getConfig().tunnels.map((t) => this.states.get(t.id) ?? { id: t.id, phase: 'idle' }),
    };
  }

  private setState(s: TunnelState) {
    this.states.set(s.id, s);
    this.emit('change', this.snapshot());
  }

  /** 경유지 SSH 연결을 연다. 이미 열려 있으면 그대로 쓴다. */
  async gateway(password?: string): Promise<Client> {
    if (this.gw) return this.gw;
    if (this.gwPending) return this.gwPending;
    const g = this.getConfig().gateway;
    this.gwPending = connectSsh(
      { label: g.name || '경유지', host: g.host, port: g.port, user: g.user, password, privateKey: this.getPrivateKey() },
      this.hostKeys,
    );
    try {
      const client = await this.gwPending;
      this.gw = client;
      this.gwMessage = undefined;
      client.on('close', () => this.onGatewayClosed(client));
      this.emit('change', this.snapshot());
      return client;
    } finally {
      this.gwPending = null;
    }
  }

  private onGatewayClosed(client: Client) {
    if (this.gw !== client) return;
    this.gw = null;
    const hadTunnels = this.open.size > 0;
    for (const id of [...this.open.keys()]) {
      this.closeServer(id);
      this.states.set(id, { id, phase: 'error', message: '경유지 연결이 끊겼습니다. 다시 연결하세요.' });
    }
    this.gwMessage = hadTunnels ? '경유지 연결이 끊겼습니다.' : undefined;
    this.emit('change', this.snapshot());
  }

  async start(id: string, password?: string): Promise<TunnelState> {
    const t = this.getConfig().tunnels.find((x) => x.id === id);
    if (!t) throw new SshError('UNKNOWN', '없는 연결입니다.');
    if (this.open.has(id)) return this.states.get(id)!;

    this.setState({ id, phase: 'connecting' });
    try {
      const gw = await this.gateway(password);
      await this.testForward(gw, t);
      await this.listen(gw, t);
      const s: TunnelState = { id, phase: 'open', message: `127.0.0.1:${t.local} → ${t.host}:${t.port}` };
      this.setState(s);
      return s;
    } catch (e) {
      const err = e instanceof SshError ? e : new SshError('UNKNOWN', e instanceof Error ? e.message : String(e));
      // 비밀번호·지문 확인은 화면에서 물어본 뒤 다시 시도하므로 오류로 표시하지 않는다
      const waiting = err.code === 'NEED_PASSWORD' || err.code === 'HOST_KEY_UNKNOWN';
      this.setState({ id, phase: waiting ? 'idle' : 'error', message: waiting ? undefined : err.message });
      throw err;
    }
  }

  /** 경유지에서 내부망 주소에 실제로 닿는지 먼저 확인한다 (ssh의 ExitOnForwardFailure) */
  private async testForward(gw: Client, t: Tunnel) {
    const timeout = new Promise<never>((_, rej) =>
      setTimeout(() => rej(new Error('timeout')), 10000).unref(),
    );
    try {
      const stream = await Promise.race([forwardOut(gw, t.host, t.port), timeout]);
      stream.destroy();
    } catch {
      throw new SshError('FORWARD_FAILED', `경유지에서 ${t.name}(${t.host}:${t.port})에 닿지 않습니다. 서버가 켜져 있는지 확인하세요.`);
    }
  }

  private listen(gw: Client, t: Tunnel): Promise<void> {
    const sockets = new Set<net.Socket>();
    const server = net.createServer((sock) => {
      sockets.add(sock);
      // DB 프로그램이 접속을 RST로 끊어도(ECONNRESET) 앱 전체가 죽지 않도록 바로 처리기를 단다
      sock.on('error', () => sock.destroy());
      sock.on('close', () => sockets.delete(sock));
      gw.forwardOut('127.0.0.1', sock.remotePort ?? 0, t.host, t.port, (err, stream) => {
        if (err || sock.destroyed) {
          stream?.destroy();
          return sock.destroy();
        }
        sock.pipe(stream).pipe(sock);
        stream.on('error', () => sock.destroy());
        sock.on('close', () => stream.destroy());
        stream.on('close', () => sock.destroy());
      });
    });
    return new Promise((resolve, reject) => {
      server.once('error', (e: NodeJS.ErrnoException) => {
        reject(
          e.code === 'EADDRINUSE'
            ? new SshError(
                'PORT_IN_USE',
                `내 PC의 ${t.local} 포트를 다른 프로그램이 쓰고 있습니다. 기존 "울산 연결" 앱에서 같은 연결을 해제한 뒤 다시 시도하세요.`,
              )
            : e,
        );
      });
      server.listen(t.local, '127.0.0.1', () => {
        this.open.set(t.id, { server, sockets });
        resolve();
      });
    });
  }

  private closeServer(id: string) {
    const o = this.open.get(id);
    if (!o) return;
    for (const s of o.sockets) s.destroy();
    o.server.close();
    this.open.delete(id);
  }

  stop(id: string) {
    this.closeServer(id);
    this.setState({ id, phase: 'idle' });
    // 열린 터널이 없으면 경유지 연결도 닫는다
    if (this.open.size === 0 && this.gw) {
      const gw = this.gw;
      this.gw = null;
      gw.end();
      this.emit('change', this.snapshot());
    }
  }

  stopAll() {
    for (const id of [...this.open.keys()]) this.closeServer(id);
    this.gw?.end();
    this.gw = null;
  }

  isOpen(id: string) {
    return this.open.has(id);
  }
}
