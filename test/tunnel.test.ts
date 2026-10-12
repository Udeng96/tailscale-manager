import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { Server, utils } from 'ssh2';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { defaultConfig } from '../electron/core/config';
import { Services } from '../electron/core/services';
import type { AppConfig, TailscaleStatus } from '../electron/shared';

// 경유지 역할을 하는 테스트용 SSH 서버 (비밀번호 'pw', direct-tcpip 허용)
let sshServer: Server;
let sshPort = 0;
let pgServer: net.Server;
let pgPort = 0;
const sshConnections = new Set<net.Socket>();

beforeAll(async () => {
  const hostKey = utils.generateKeyPairSync('ed25519').private;
  sshServer = new Server({ hostKeys: [hostKey] }, (client) => {
    client.on('authentication', (ctx) => (ctx.method === 'password' && ctx.password === 'pw' ? ctx.accept() : ctx.reject()));
    client.on('ready', () => {
      client.on('tcpip', (accept, reject, info) => {
        if (info.destPort !== pgPort) return reject();
        const sock = net.connect(info.destPort, '127.0.0.1', () => {
          const ch = accept();
          ch.pipe(sock).pipe(ch);
        });
        sock.on('error', () => reject());
      });
    });
    client.on('error', () => {});
  });
  // ssh2 Server의 'connection'은 클라이언트 객체라서 안쪽 net.Server에서 TCP 소켓을 받는다
  (sshServer as unknown as { _srv: net.Server })._srv.on('connection', (sock: net.Socket) => {
    sshConnections.add(sock);
    sock.on('close', () => sshConnections.delete(sock));
  });
  await new Promise<void>((r) => sshServer.listen(0, '127.0.0.1', r));
  sshPort = (sshServer.address() as net.AddressInfo).port;

  pgServer = net.createServer((s) => s.once('data', () => s.write('S')));
  await new Promise<void>((r) => pgServer.listen(0, '127.0.0.1', r));
  pgPort = (pgServer.address() as net.AddressInfo).port;
});

afterAll(() => {
  sshServer.close();
  pgServer.close();
});

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tsm-'));
  const config: AppConfig = defaultConfig();
  config.gateway = { name: '테스트 경유지', host: '127.0.0.1', port: sshPort, user: 'user' };
  config.tunnels = [
    { id: 'db', name: '테스트 DB', host: '127.0.0.1', port: pgPort, local: 0, user: '', kind: 'db' },
    { id: 'bad', name: '없는 서버', host: '127.0.0.1', port: 1, local: 0, user: '', kind: 'db' },
  ];
  const ts: TailscaleStatus = {
    installed: true, cliPath: 'x', backendState: 'Running', running: true,
    self: { name: 'me', dnsName: '', ips: ['100.0.0.1'], os: 'macOS', online: true, lastSeen: null, self: true },
    peers: [],
  };
  const svc = new Services(dir, () => config, async () => ts, path.join(dir, 'none'));
  return { svc, config };
}

async function freePort() {
  const s = net.createServer();
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
  const p = (s.address() as net.AddressInfo).port;
  await new Promise((r) => s.close(r));
  return p;
}

describe('tunnel', () => {
  it('비밀번호 → 지문 확인 → 터널 → DB 응답까지', async () => {
    const { svc, config } = setup();
    config.tunnels[0].local = await freePort();

    await expect(svc.tunnels.start('db')).rejects.toMatchObject({ code: 'NEED_PASSWORD' });
    await expect(svc.tunnels.start('db', 'wrong')).rejects.toMatchObject({ code: 'HOST_KEY_UNKNOWN' });

    let hk: { fingerprint?: string; hostKeyId?: string } = {};
    try {
      await svc.tunnels.start('db', 'pw');
    } catch (e) {
      hk = e as typeof hk;
    }
    svc.hostKeys.trust(hk.hostKeyId!, hk.fingerprint!);

    await expect(svc.tunnels.start('db', 'wrong')).rejects.toMatchObject({ code: 'AUTH_FAILED' });
    const st = await svc.tunnels.start('db', 'pw');
    expect(st.phase).toBe('open');

    const steps = await svc.checkDb('db');
    expect(steps.every((s) => s.ok)).toBe(true);
    expect(steps.at(-1)!.detail).toContain('SSL');

    // 경유지에서 닿지 않는 주소
    config.tunnels[1].local = await freePort();
    await expect(svc.tunnels.start('bad')).rejects.toMatchObject({ code: 'FORWARD_FAILED' });

    svc.tunnels.stop('db');
    expect(svc.tunnels.snapshot().gateway.connected).toBe(false);
    const after = await svc.checkDb('db');
    expect(after.find((s) => s.label === '터널')!.ok).toBe(false);
  });

  it('포트가 이미 쓰이면 PORT_IN_USE', async () => {
    const { svc, config } = setup();
    const blocker = net.createServer();
    await new Promise<void>((r) => blocker.listen(0, '127.0.0.1', r));
    config.tunnels[0].local = (blocker.address() as net.AddressInfo).port;
    try {
      await svc.tunnels.start('db', 'pw');
    } catch (e) {
      const err = e as { fingerprint: string; hostKeyId: string };
      svc.hostKeys.trust(err.hostKeyId, err.fingerprint);
    }
    await expect(svc.tunnels.start('db', 'pw')).rejects.toMatchObject({ code: 'PORT_IN_USE' });
    svc.tunnels.stopAll();
    blocker.close();
  });
});

describe('연결 끊김', () => {
  it('로컬 접속이 RST로 끊기거나 경유지 연결이 끊겨도 앱이 죽지 않는다', async () => {
    const { svc, config } = setup();
    config.tunnels[0].local = await freePort();
    try {
      await svc.tunnels.start('db', 'pw');
    } catch (e) {
      const err = e as { fingerprint: string; hostKeyId: string };
      svc.hostKeys.trust(err.hostKeyId, err.fingerprint);
    }
    await svc.tunnels.start('db', 'pw');

    // DataGrip 등이 접속하자마자 RST로 끊는 경우
    for (let i = 0; i < 5; i++) {
      const s = net.connect(config.tunnels[0].local, '127.0.0.1');
      await new Promise<void>((r) => s.on('connect', () => r()));
      s.resetAndDestroy();
    }
    await new Promise((r) => setTimeout(r, 200));

    // 경유지 쪽 TCP 연결이 갑자기 끊기는 경우
    for (const c of sshConnections) c.destroy();
    await new Promise((r) => setTimeout(r, 300));
    expect(svc.tunnels.snapshot().tunnels[0].phase).toBe('error');
    expect(svc.tunnels.snapshot().gateway.connected).toBe(false);
  });
});
