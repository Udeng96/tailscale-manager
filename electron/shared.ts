// main 프로세스와 화면(React)이 같이 쓰는 타입

export type TunnelKind = 'db' | 'ssh';

/** 울산 Windows PC(경유지)를 거쳐 내부망으로 여는 로컬 포트 포워딩 하나 */
export interface Tunnel {
  id: string;
  name: string;
  /** 경유지에서 본 내부망 주소 */
  host: string;
  port: number;
  /** 이 PC의 127.0.0.1 포트 */
  local: number;
  /** kind가 ssh일 때 서버 로그인 계정 */
  user: string;
  kind: TunnelKind;
  /** kind가 db일 때 연결 정보 표시용 */
  database?: string;
  dbUser?: string;
}

export interface Gateway {
  name: string;
  host: string;
  port: number;
  user: string;
}

export interface AppConfig {
  gateway: Gateway;
  tunnels: Tunnel[];
}

export interface TailscalePeer {
  name: string;
  dnsName: string;
  ips: string[];
  os: string;
  online: boolean;
  lastSeen: string | null;
  self: boolean;
}

export interface TailscaleStatus {
  installed: boolean;
  cliPath: string | null;
  /** Running, Stopped, NeedsLogin, NoState 등 */
  backendState: string;
  running: boolean;
  self: TailscalePeer | null;
  peers: TailscalePeer[];
  error?: string;
}

export type TunnelPhase = 'idle' | 'connecting' | 'open' | 'error';

export interface TunnelState {
  id: string;
  phase: TunnelPhase;
  message?: string;
}

export interface GatewayState {
  connected: boolean;
  message?: string;
}

export interface CheckStep {
  label: string;
  ok: boolean;
  detail: string;
}

export interface KeyStatus {
  exists: boolean;
  publicKey: string | null;
  path: string;
}

/** 실패 사유를 화면에서 구분하기 위한 코드 */
export type ErrorCode =
  | 'NEED_PASSWORD'
  | 'AUTH_FAILED'
  | 'HOST_KEY_UNKNOWN'
  | 'HOST_KEY_CHANGED'
  | 'PORT_IN_USE'
  | 'UNREACHABLE'
  | 'FORWARD_FAILED'
  | 'UNKNOWN';

export interface ApiError {
  code: ErrorCode;
  message: string;
  /** HOST_KEY_* 일 때 확인할 지문 */
  fingerprint?: string;
  hostKeyId?: string;
}

export type Result<T> = { ok: true; value: T } | { ok: false; error: ApiError };

export interface DeepLink {
  action: string;
  params: Record<string, string>;
}

/** preload가 window.api로 노출하는 함수들 */
export interface Api {
  getConfig(): Promise<AppConfig>;
  saveConfig(config: AppConfig): Promise<Result<AppConfig>>;
  importUlsanConnect(): Promise<Result<AppConfig>>;

  tailscaleStatus(): Promise<TailscaleStatus>;
  tailscaleUp(): Promise<Result<TailscaleStatus>>;
  tailscaleDown(): Promise<Result<TailscaleStatus>>;

  tunnelStates(): Promise<{ gateway: GatewayState; tunnels: TunnelState[] }>;
  startTunnel(id: string, password?: string): Promise<Result<TunnelState>>;
  stopTunnel(id: string): Promise<void>;
  trustHostKey(hostKeyId: string, fingerprint: string): Promise<void>;
  checkDb(id: string): Promise<CheckStep[]>;

  keyStatus(): Promise<KeyStatus>;
  generateKey(): Promise<Result<KeyStatus>>;
  /** target: 'gateway' 또는 ssh 터널 id */
  installKey(target: string, password: string): Promise<Result<string>>;

  onTunnelStates(cb: (s: { gateway: GatewayState; tunnels: TunnelState[] }) => void): () => void;
  onDeepLink(cb: (link: DeepLink) => void): () => void;
}
