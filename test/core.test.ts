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
      { id: 'db-primary', name: 'Example connection 2', host: '203.0.113.1', port: 5432, local: 15432, user: '', kind: 'db' },
      { id: 'db-secondary', name: 'Example connection 3', host: '203.0.113.2', port: 15431, local: 15433, user: '', kind: 'db' },
      { id: 'demo-ssh', name: 'Example connection 6', host: '203.0.113.4', port: 10311, user: 'demo-user', local: 10311, kind: 'ssh', logPath: '/var/log/demo-service' },
    ];
    const merged = mergeUlsanConnect(defaultConfig(), rows);
    expect(merged.tunnels).toHaveLength(3);
    const main = merged.tunnels.find((t) => t.id === 'db-primary')!;
    expect(main.database).toBe('demo_database');
    expect(main.dbUser).toBe('demo-db-user');
    expect(merged.tunnels.find((t) => t.id === 'demo-ssh')).toMatchObject({ kind: 'ssh', user: 'demo-user', local: 10311 });
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
    Self: { HostName: 'demo-node-1', DNSName: 'demo-node.example.test.', TailscaleIPs: ['203.0.113.5'], OS: 'macOS' },
    Peer: {
      a: { HostName: 'demo-node-2', TailscaleIPs: ['203.0.113.3'], OS: 'windows', Online: true, LastSeen: '0001-01-01T00:00:00Z' },
      b: { HostName: 'demo-node-3', TailscaleIPs: ['203.0.113.6'], OS: 'linux', Online: false, LastSeen: '2026-10-01T00:00:00Z' },
    },
  });

  it('status --json을 읽는다', () => {
    const s = parseStatus(sample, '/usr/local/bin/tailscale');
    expect(s.running).toBe(true);
    expect(s.self?.ips).toEqual(['203.0.113.5']);
    expect(s.self?.dnsName).toBe('demo-node.example.test');
    expect(s.peers[0]).toMatchObject({ name: 'demo-node-2', online: true, lastSeen: null });
    expect(s.peers[1]).toMatchObject({ name: 'demo-node-3', online: false });
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
    const hash = crypto.createHmac('sha1', salt).update('203.0.113.3').digest('base64');
    const content = [
      `other.host ssh-ed25519 ${crypto.randomBytes(51).toString('base64')}`,
      `|1|${salt.toString('base64')}|${hash} ssh-ed25519 ${b64}`,
      `[203.0.113.7]:2222 ssh-ed25519 ${b64}`,
    ].join('\n');
    expect(fingerprintsFromKnownHosts(content, '203.0.113.3', 22)).toEqual([fingerprint(key)]);
    expect(fingerprintsFromKnownHosts(content, '203.0.113.7', 2222)).toEqual([fingerprint(key)]);
    expect(fingerprintsFromKnownHosts(content, '203.0.113.7', 22)).toEqual([]);
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
    if (process.platform === 'win32') {
      const acl = execFileSync('icacls', [ks.privatePath], { encoding: 'utf8', windowsHide: true });
      expect(acl).not.toContain('(I)');
      expect(acl).toContain('(F)');
    } else {
      expect(fs.statSync(ks.privatePath).mode & 0o777).toBe(0o600);
    }
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
    if (process.platform === 'win32') {
      // NTFS cannot report POSIX modes; the shell command still runs above.
      expect(linuxInstallCommand(pub)).toContain('umask 077');
      expect(linuxInstallCommand(pub)).toContain('chmod 700 ~/.ssh && chmod 600 ~/.ssh/authorized_keys');
    } else {
      expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    }
  });

  it('공개키 형식이 아니면 명령을 만들지 않는다', () => {
    expect(() => windowsInstallScript("ssh-ed25519 AAAA x'; rm -rf /")).toThrow();
  });
});

describe('deeplink', () => {
  it('upload 링크를 읽는다', () => {
    const l = parseDeepLink('tailscale-manager://upload?file=%2FUsers%2Fa%2Fb.war&server=demo-ssh');
    expect(l).toEqual({ action: 'upload', params: { file: '/Users/a/b.war', server: 'demo-ssh' } });
    expect(parseDeepLink('https://x')).toBeNull();
  });
});
