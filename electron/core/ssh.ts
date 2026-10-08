import { Client, type ConnectConfig } from 'ssh2';
import type { Duplex } from 'node:stream';
import type { ApiError, ErrorCode } from '../shared';
import { fingerprint, type HostKeyStore } from './hostKeys';

export class SshError extends Error implements ApiError {
  constructor(
    public code: ErrorCode,
    message: string,
    public fingerprint?: string,
    public hostKeyId?: string,
  ) {
    super(message);
  }
}

export function toApiError(e: unknown): ApiError {
  if (e instanceof SshError) return { code: e.code, message: e.message, fingerprint: e.fingerprint, hostKeyId: e.hostKeyId };
  return { code: 'UNKNOWN', message: e instanceof Error ? e.message : String(e) };
}

export interface SshTarget {
  label: string;
  host: string;
  port: number;
  user: string;
  password?: string;
  privateKey?: string;
  /** 경유지를 거칠 때 forwardOut으로 얻은 스트림 */
  sock?: Duplex;
}

export function connectSsh(target: SshTarget, hostKeys: HostKeyStore, timeoutMs = 15000): Promise<Client> {
  if (!target.password && !target.privateKey) {
    return Promise.reject(new SshError('NEED_PASSWORD', `${target.label}: 비밀번호가 필요합니다.`));
  }
  const hostKeyId = `${target.host}:${target.port}`;
  let hostKeyProblem: SshError | null = null;

  return new Promise((resolve, reject) => {
    const client = new Client();
    const cfg: ConnectConfig = {
      host: target.sock ? undefined : target.host,
      port: target.sock ? undefined : target.port,
      sock: target.sock,
      username: target.user,
      password: target.password,
      privateKey: target.privateKey,
      readyTimeout: timeoutMs,
      keepaliveInterval: 30000,
      keepaliveCountMax: 3,
      hostVerifier: (key: Buffer) => {
        const fp = fingerprint(key);
        const state = hostKeys.check(target.host, target.port, fp);
        if (state === 'trusted') return true;
        hostKeyProblem =
          state === 'unknown'
            ? new SshError('HOST_KEY_UNKNOWN', `${target.label}에 처음 접속합니다. 서버 지문을 확인하세요.`, fp, hostKeyId)
            : new SshError(
                'HOST_KEY_CHANGED',
                `${target.label}의 서버 지문이 저장된 값과 다릅니다. 서버가 바뀌었거나 중간에서 가로채는 중일 수 있습니다.`,
                fp,
                hostKeyId,
              );
        return false;
      },
    };

    client.once('ready', () => resolve(client));
    client.once('error', (err: Error & { level?: string; code?: string }) => {
      client.end();
      if (hostKeyProblem) return reject(hostKeyProblem);
      if (err.level === 'client-authentication') {
        return reject(
          target.password
            ? new SshError('AUTH_FAILED', `${target.label}: 계정 또는 비밀번호가 맞지 않습니다.`)
            : new SshError('NEED_PASSWORD', `${target.label}: 등록된 키로 로그인하지 못했습니다. 비밀번호가 필요합니다.`),
        );
      }
      if (err.level === 'client-timeout' || ['ECONNREFUSED', 'ETIMEDOUT', 'EHOSTUNREACH', 'ENETUNREACH', 'ENOTFOUND'].includes(err.code ?? '')) {
        return reject(new SshError('UNREACHABLE', `${target.label}(${target.host}:${target.port})에 접속할 수 없습니다. Tailscale과 상대 PC가 켜져 있는지 확인하세요.`));
      }
      reject(new SshError('UNKNOWN', `${target.label}: ${err.message}`));
    });
    client.connect(cfg);
  });
}

export function exec(client: Client, command: string): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    client.exec(command, (err, stream) => {
      if (err) return reject(err);
      let stdout = '';
      let stderr = '';
      stream.on('data', (d: Buffer) => (stdout += d.toString()));
      stream.stderr.on('data', (d: Buffer) => (stderr += d.toString()));
      stream.on('close', (code: number | null) => resolve({ code: code ?? 0, stdout, stderr }));
    });
  });
}

export function forwardOut(client: Client, host: string, port: number): Promise<Duplex> {
  return new Promise((resolve, reject) => {
    client.forwardOut('127.0.0.1', 0, host, port, (err, stream) => (err ? reject(err) : resolve(stream)));
  });
}
