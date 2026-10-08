import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function fingerprint(key: Buffer): string {
  return 'SHA256:' + crypto.createHash('sha256').update(key).digest('base64').replace(/=+$/, '');
}

/** known_hosts에 쓰는 호스트 이름 형식 (22번이 아니면 [host]:port) */
export function knownHostsName(host: string, port: number): string {
  return port === 22 ? host : `[${host}]:${port}`;
}

function hostMatches(pattern: string, name: string): boolean {
  if (pattern.startsWith('|1|')) {
    const [, , salt, hash] = pattern.split('|');
    const h = crypto.createHmac('sha1', Buffer.from(salt, 'base64')).update(name).digest('base64');
    return h === hash;
  }
  return pattern.split(',').includes(name);
}

/** OpenSSH known_hosts 내용에서 이 호스트의 키 지문들을 찾는다 */
export function fingerprintsFromKnownHosts(content: string, host: string, port: number): string[] {
  const name = knownHostsName(host, port);
  const out: string[] = [];
  for (const line of content.split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith('#') || t.startsWith('@')) continue;
    const [hosts, , b64] = t.split(/\s+/);
    if (!hosts || !b64 || !hostMatches(hosts, name)) continue;
    out.push(fingerprint(Buffer.from(b64, 'base64')));
  }
  return out;
}

/**
 * 서버 호스트 키 확인.
 * 이 앱이 저장한 지문 → 없으면 ~/.ssh/known_hosts 순서로 본다.
 */
export class HostKeyStore {
  constructor(
    private file: string,
    private sshKnownHosts = path.join(os.homedir(), '.ssh', 'known_hosts'),
  ) {}

  private read(): Record<string, string> {
    try {
      return JSON.parse(fs.readFileSync(this.file, 'utf8'));
    } catch {
      return {};
    }
  }

  /** 'trusted' | 'unknown' | 'changed' */
  check(host: string, port: number, fp: string): 'trusted' | 'unknown' | 'changed' {
    const saved = this.read()[`${host}:${port}`];
    if (saved) return saved === fp ? 'trusted' : 'changed';
    let known: string[] = [];
    try {
      known = fingerprintsFromKnownHosts(fs.readFileSync(this.sshKnownHosts, 'utf8'), host, port);
    } catch {
      // known_hosts가 없으면 처음 보는 서버로 처리
    }
    if (known.length === 0) return 'unknown';
    return known.includes(fp) ? 'trusted' : 'changed';
  }

  trust(hostKeyId: string, fp: string) {
    const all = this.read();
    all[hostKeyId] = fp;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify(all, null, 2), { mode: 0o600 });
  }
}
