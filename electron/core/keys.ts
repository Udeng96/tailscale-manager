import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { utils } from 'ssh2';
import type { KeyStatus } from '../shared';

export class KeyStore {
  readonly privatePath: string;
  readonly publicPath: string;

  constructor(dir: string) {
    this.privatePath = path.join(dir, 'id_ed25519');
    this.publicPath = `${this.privatePath}.pub`;
  }

  status(): KeyStatus {
    const exists = fs.existsSync(this.privatePath) && fs.existsSync(this.publicPath);
    return { exists, publicKey: exists ? fs.readFileSync(this.publicPath, 'utf8').trim() : null, path: this.privatePath };
  }

  privateKey(): string | undefined {
    try {
      return fs.readFileSync(this.privatePath, 'utf8');
    } catch {
      return undefined;
    }
  }

  /** 이 앱 전용 ed25519 키를 만든다. 이미 있으면 그대로 둔다. */
  generate(): KeyStatus {
    if (this.status().exists) return this.status();
    const pair = utils.generateKeyPairSync('ed25519', { comment: `tailscale-manager@${os.hostname()}` });
    fs.mkdirSync(path.dirname(this.privatePath), { recursive: true, mode: 0o700 });
    fs.writeFileSync(this.privatePath, pair.private, { mode: 0o600 });
    fs.writeFileSync(this.publicPath, pair.public + '\n', { mode: 0o644 });
    return this.status();
  }
}

function assertSafeKey(pub: string) {
  // 명령에 그대로 들어가므로 공개키 형식만 허용
  if (!/^ssh-ed25519 [A-Za-z0-9+/=]+ [\w.@-]+$/.test(pub)) throw new Error('공개키 형식이 올바르지 않습니다.');
}

/**
 * Windows OpenSSH 서버에 공개키를 등록하는 PowerShell 스크립트.
 * 관리자 그룹 계정은 ProgramData\ssh\administrators_authorized_keys 를 보고,
 * 일반 계정은 %USERPROFILE%\.ssh\authorized_keys 를 본다.
 */
export function windowsInstallScript(pub: string): string {
  assertSafeKey(pub);
  return [
    `$k = '${pub}'`,
    `$admin = [bool](whoami /groups | Select-String 'S-1-5-32-544')`,
    `if ($admin) { $f = Join-Path $env:ProgramData 'ssh\\administrators_authorized_keys' } else { $d = Join-Path $env:USERPROFILE '.ssh'; New-Item -ItemType Directory -Force -Path $d | Out-Null; $f = Join-Path $d 'authorized_keys' }`,
    `if ((Test-Path $f) -and (Select-String -Path $f -SimpleMatch $k -Quiet)) { Write-Output "EXISTS $f"; exit 0 }`,
    `Add-Content -Path $f -Value $k -Encoding ascii`,
    `if ($admin) { icacls $f /inheritance:r /grant '*S-1-5-32-544:F' /grant '*S-1-5-18:F' | Out-Null }`,
    `Write-Output "ADDED $f"`,
  ].join('\n');
}

/** cmd.exe가 기본 셸이어도 따옴표 문제 없이 실행되도록 UTF-16LE base64로 넘긴다 */
export function windowsInstallCommand(pub: string): string {
  const encoded = Buffer.from(windowsInstallScript(pub), 'utf16le').toString('base64');
  return `powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand ${encoded}`;
}

export function linuxInstallCommand(pub: string): string {
  assertSafeKey(pub);
  return [
    'umask 077',
    'mkdir -p ~/.ssh',
    'touch ~/.ssh/authorized_keys',
    `if grep -qxF '${pub}' ~/.ssh/authorized_keys; then echo EXISTS; else echo '${pub}' >> ~/.ssh/authorized_keys && echo ADDED; fi`,
    'chmod 700 ~/.ssh && chmod 600 ~/.ssh/authorized_keys',
  ].join(' && ');
}
