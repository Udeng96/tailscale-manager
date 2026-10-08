import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { defaultConfig, mergeUlsanConnect, validateConfig } from '../electron/core/config';
import { fingerprint, fingerprintsFromKnownHosts } from '../electron/core/hostKeys';
import { KeyStore, linuxInstallCommand, windowsInstallScript } from '../electron/core/keys';
import { probePostgres } from '../electron/core/pgProbe';
import { cliCandidates, findCli, parseStatus } from '../electron/core/tailscale';
import { parseDeepLink } from '../electron/deeplink';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'tsm-'));

describe('config', () => {
  it('기존 울산 연결 앱 설정을 가져오면서 DB 정보는 유지한다', () => {
    const rows = [
      { id: 'db-main', name: '울산 운영 DB', host: '10.10.11.100', port: 5432, local: 15432, user: '', kind: 'db' },
      { id: 'db-vendor', name: '업체 DB', host: '10.10.11.201', port: 15431, local: 15433, user: '', kind: 'db' },
      { id: '44d5371fe258', name: 'dashboard', host: '10.10.11.103', port: 10311, user: 'rino', local: 10311, kind: 'ssh', logPath: '/x' },
    ];
    const merged = mergeUlsanConnect(defaultConfig(), rows);
    expect(merged.tunnels).toHaveLength(3);
    const main = merged.tunnels.find((t) => t.id === 'db-main')!;
    expect(main.database).toBe('2026_ulsan');
    expect(main.dbUser).toBe('rino_sos');
    expect(merged.tunnels.find((t) => t.id === '44d5371fe258')).toMatchObject({ kind: 'ssh', user: 'rino', local: 10311 });
  });

  it('배열이 아니면 거부한다', () => {
    expect(() => mergeUlsanConnect(defaultConfig(), { a: 1 })).toThrow(/배열/);
  });

  it('내 PC 포트 중복을 막는다', () => {
    const c = defaultConfig();
    c.tunnels[1].local = c.tunnels[0].local;
    expect(() => validateConfig(c)).toThrow(/겹칩니다/);
  });
});

describe('tailscale', () => {
  const sample = JSON.stringify({
    BackendState: 'Running',
    Self: { HostName: 'youui-macbookpro', DNSName: 'youui-macbookpro.tail.ts.net.', TailscaleIPs: ['100.82.217.8'], OS: 'macOS' },
    Peer: {
      a: { HostName: 'desktop-vvtm95n', TailscaleIPs: ['100.115.250.35'], OS: 'windows', Online: true, LastSeen: '0001-01-01T00:00:00Z' },
      b: { HostName: 'old-pc', TailscaleIPs: ['100.1.1.1'], OS: 'linux', Online: false, LastSeen: '2026-10-01T00:00:00Z' },
    },
  });

  it('status --json을 읽는다', () => {
    const s = parseStatus(sample, '/usr/local/bin/tailscale');
    expect(s.running).toBe(true);
    expect(s.self?.ips).toEqual(['100.82.217.8']);
    expect(s.self?.dnsName).toBe('youui-macbookpro.tail.ts.net');
    expect(s.peers[0]).toMatchObject({ name: 'desktop-vvtm95n', online: true, lastSeen: null });
    expect(s.peers[1]).toMatchObject({ name: 'old-pc', online: false });
  });

  it('꺼져 있으면 running=false', () => {
    expect(parseStatus(JSON.stringify({ BackendState: 'Stopped' }), null).running).toBe(false);
  });

  it('Mac은 /usr/local/bin을 먼저 찾는다', () => {
    expect(cliCandidates('darwin')[0]).toBe('/usr/local/bin/tailscale');
    expect(findCli('darwin', (p) => p.startsWith('/Applications'))).toContain('Tailscale.app');
    expect(findCli('win32', () => false)).toBeNull();
  });
});

describe('known_hosts', () => {
  const key = crypto.randomBytes(51);
  const b64 = key.toString('base64');

  it('일반·해시 형식 모두 찾는다', () => {
    const salt = crypto.randomBytes(20);
    const hash = crypto.createHmac('sha1', salt).update('100.115.250.35').digest('base64');
    const content = [
      `other.host ssh-ed25519 ${crypto.randomBytes(51).toString('base64')}`,
      `|1|${salt.toString('base64')}|${hash} ssh-ed25519 ${b64}`,
      `[10.0.0.1]:2222 ssh-ed25519 ${b64}`,
    ].join('\n');
    expect(fingerprintsFromKnownHosts(content, '100.115.250.35', 22)).toEqual([fingerprint(key)]);
    expect(fingerprintsFromKnownHosts(content, '10.0.0.1', 2222)).toEqual([fingerprint(key)]);
    expect(fingerprintsFromKnownHosts(content, '10.0.0.1', 22)).toEqual([]);
  });
});

describe('postgres probe', () => {
  it("SSLRequest에 'N'으로 답하면 PostgreSQL로 본다", async () => {
    const server = net.createServer((s) => s.once('data', (d) => s.write(d.readInt32BE(4) === 80877103 ? 'N' : 'X')));
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as net.AddressInfo).port;
    expect(await probePostgres('127.0.0.1', port)).toEqual({ ok: true, ssl: false });
    server.close();
  });

  it('닫힌 포트는 실패', async () => {
    const r = await probePostgres('127.0.0.1', 1);
    expect(r.ok).toBe(false);
  });
});

describe('ssh key', () => {
  it('ed25519 키를 만들고 다시 만들지 않는다', () => {
    const ks = new KeyStore(tmp());
    const a = ks.generate();
    expect(a.publicKey).toMatch(/^ssh-ed25519 /);
    expect(fs.statSync(ks.privatePath).mode & 0o777).toBe(0o600);
    expect(ks.generate().publicKey).toBe(a.publicKey);
  });

  it('Linux 등록 명령은 한 번만 추가한다', () => {
    const home = tmp();
    const pub = new KeyStore(tmp()).generate().publicKey!;
    const run = () => execFileSync('sh', ['-c', linuxInstallCommand(pub)], { env: { ...process.env, HOME: home } }).toString().trim();
    expect(run()).toBe('ADDED');
    expect(run()).toBe('EXISTS');
    const file = path.join(home, '.ssh', 'authorized_keys');
    expect(fs.readFileSync(file, 'utf8').trim()).toBe(pub);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
  });

  it('공개키 형식이 아니면 명령을 만들지 않는다', () => {
    expect(() => windowsInstallScript("ssh-ed25519 AAAA x'; rm -rf /")).toThrow();
  });
});

describe('deeplink', () => {
  it('upload 링크를 읽는다', () => {
    const l = parseDeepLink('tailscale-manager://upload?file=%2FUsers%2Fa%2Fb.war&server=dashboard');
    expect(l).toEqual({ action: 'upload', params: { file: '/Users/a/b.war', server: 'dashboard' } });
    expect(parseDeepLink('https://x')).toBeNull();
  });
});
