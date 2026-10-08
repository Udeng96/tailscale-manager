import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AppConfig, Tunnel } from '../shared';

export const DATA_DIR = path.join(os.homedir(), '.tailscale-manager');
export const CONFIG_PATH = path.join(DATA_DIR, 'config.json');

/** 기존 "울산 연결" 앱이 쓰는 설정 파일 (Mac) */
export const ULSAN_CONNECT_PATH = path.join(
  os.homedir(),
  'Library',
  'Application Support',
  'UlsanConnect',
  'connections.json',
);

export function defaultConfig(): AppConfig {
  return {
    gateway: { name: '울산 Windows PC (desktop-vvtm95n)', host: '100.115.250.35', port: 22, user: 'user' },
    tunnels: [
      {
        id: 'db-main',
        name: '울산 운영 DB',
        host: '10.10.11.100',
        port: 5432,
        local: 15432,
        user: '',
        kind: 'db',
        database: '2026_ulsan',
        dbUser: 'rino_sos',
      },
      { id: 'db-vendor', name: '업체 DB', host: '10.10.11.201', port: 15431, local: 15433, user: '', kind: 'db' },
    ],
  };
}

/** 잘못된 값이 있으면 사람이 읽을 수 있는 문장을 던진다 */
export function validateConfig(config: AppConfig): AppConfig {
  const g = config.gateway;
  if (!g?.host?.trim()) throw new Error('경유지 주소를 입력하세요.');
  if (!g.user?.trim()) throw new Error('경유지 계정을 입력하세요.');
  checkPort(g.port, '경유지 SSH 포트');

  const ids = new Set<string>();
  const locals = new Set<number>();
  for (const t of config.tunnels) {
    if (!t.name?.trim()) throw new Error('연결 이름을 입력하세요.');
    if (!t.host?.trim()) throw new Error(`${t.name}: 내부망 주소를 입력하세요.`);
    checkPort(t.port, `${t.name}: 내부망 포트`);
    checkPort(t.local, `${t.name}: 내 PC 포트`);
    if (t.local < 1024) throw new Error(`${t.name}: 내 PC 포트는 1024 이상이어야 합니다.`);
    if (t.kind !== 'db' && t.kind !== 'ssh') throw new Error(`${t.name}: 종류는 db 또는 ssh 입니다.`);
    if (t.kind === 'ssh' && !t.user?.trim()) throw new Error(`${t.name}: 서버 로그인 계정을 입력하세요.`);
    if (ids.has(t.id)) throw new Error(`${t.name}: id가 중복됩니다.`);
    if (locals.has(t.local)) throw new Error(`${t.name}: 내 PC 포트 ${t.local}가 다른 연결과 겹칩니다.`);
    ids.add(t.id);
    locals.add(t.local);
  }
  return config;
}

function checkPort(n: number, label: string) {
  if (!Number.isInteger(n) || n < 1 || n > 65535) throw new Error(`${label}는 1~65535 사이 숫자여야 합니다.`);
}

export function loadConfig(file = CONFIG_PATH): AppConfig {
  if (!fs.existsSync(file)) return defaultConfig();
  const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as AppConfig;
  return { gateway: { ...defaultConfig().gateway, ...raw.gateway }, tunnels: raw.tunnels ?? [] };
}

export function saveConfig(config: AppConfig, file = CONFIG_PATH): AppConfig {
  validateConfig(config);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(config, null, 2), 'utf8');
  fs.renameSync(tmp, file);
  return config;
}

/**
 * "울산 연결" 앱의 connections.json(서버 객체 배열)을 이 앱의 터널 목록으로 바꾼다.
 * 같은 id가 이미 있으면 이 앱 쪽 추가 정보(database, dbUser)는 유지하고 주소·포트만 갱신한다.
 */
export function mergeUlsanConnect(current: AppConfig, rows: unknown): AppConfig {
  if (!Array.isArray(rows)) throw new Error('connections.json 형식이 예상과 다릅니다 (배열이 아님).');
  const byId = new Map(current.tunnels.map((t) => [t.id, t]));
  for (const r of rows as Record<string, unknown>[]) {
    const kind = r.kind === 'db' ? 'db' : 'ssh';
    const imported: Tunnel = {
      id: String(r.id ?? ''),
      name: String(r.name ?? ''),
      host: String(r.host ?? ''),
      port: Number(r.port),
      local: Number(r.local),
      user: String(r.user ?? ''),
      kind,
    };
    if (!imported.id) continue;
    const prev = byId.get(imported.id);
    byId.set(imported.id, { ...prev, ...imported });
  }
  return validateConfig({ gateway: current.gateway, tunnels: [...byId.values()] });
}

export function importUlsanConnect(current: AppConfig, file = ULSAN_CONNECT_PATH): AppConfig {
  if (!fs.existsSync(file)) throw new Error(`기존 "울산 연결" 앱 설정 파일이 없습니다: ${file}`);
  return mergeUlsanConnect(current, JSON.parse(fs.readFileSync(file, 'utf8')));
}
