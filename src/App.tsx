import { useCallback, useEffect, useRef, useState } from 'react';
import {
  api,
  type AppConfig,
  type CheckStep,
  type DeepLink,
  type GatewayState,
  type KeyStatus,
  type TailscaleStatus,
  type Tunnel,
  type TunnelState,
} from './api';
import { Modals } from './Modals';
import { Settings } from './Settings';
import { useConnect } from './useConnect';

type Toast = { id: number; msg: string; bad?: boolean };

const KEY_FLAG = 'keyInstalled:';

export function App() {
  const [config, setConfig] = useState<AppConfig | null>(null);
  const [ts, setTs] = useState<TailscaleStatus | null>(null);
  const [tsBusy, setTsBusy] = useState(false);
  const [gateway, setGateway] = useState<GatewayState>({ connected: false });
  const [states, setStates] = useState<Record<string, TunnelState>>({});
  const [key, setKey] = useState<KeyStatus | null>(null);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [check, setCheck] = useState<{ name: string; steps: CheckStep[] | null } | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [link, setLink] = useState<DeepLink | null>(null);
  const toastId = useRef(0);

  const notify = useCallback((msg: string, bad?: boolean) => {
    const id = ++toastId.current;
    setToasts((t) => [...t, { id, msg, bad }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), bad ? 8000 : 3500);
  }, []);
  const { prompt, run } = useConnect(notify);

  const refreshTs = useCallback(() => api.tailscaleStatus().then(setTs), []);

  useEffect(() => {
    api.getConfig().then(setConfig);
    api.keyStatus().then(setKey);
    refreshTs();
    const apply = (s: { gateway: GatewayState; tunnels: TunnelState[] }) => {
      setGateway(s.gateway);
      setStates(Object.fromEntries(s.tunnels.map((t) => [t.id, t])));
    };
    api.tunnelStates().then(apply);
    const offT = api.onTunnelStates(apply);
    const offL = api.onDeepLink(setLink);
    const timer = setInterval(refreshTs, 10000);
    return () => {
      offT();
      offL();
      clearInterval(timer);
    };
  }, [refreshTs]);

  async function toggleTailscale() {
    if (!ts) return;
    setTsBusy(true);
    const r = ts.running ? await api.tailscaleDown() : await api.tailscaleUp();
    setTsBusy(false);
    if (r.ok) setTs(r.value);
    else notify(r.error.message, true);
  }

  async function connect(t: Tunnel) {
    const ok = await run(`${config?.gateway.name ?? '경유지'} 비밀번호`, (pw) => api.startTunnel(t.id, pw));
    if (ok) notify(`${t.name} 연결됨 (127.0.0.1:${t.local})`);
  }

  async function runCheck(t: Tunnel) {
    setCheck({ name: t.name, steps: null });
    setCheck({ name: t.name, steps: await api.checkDb(t.id) });
  }

  async function installKey(target: string, label: string) {
    const msg = await run(`${label} 비밀번호 (키 등록용)`, (pw) => api.installKey(target, pw ?? ''));
    if (msg) {
      localStorage.setItem(KEY_FLAG + target, '1');
      notify(msg);
      setKey(await api.keyStatus());
    }
  }

  function copy(text: string, what: string) {
    navigator.clipboard.writeText(text).then(() => notify(`${what} 복사됨`));
  }

  if (!config) return <div className="loading">불러오는 중…</div>;

  const gwPeer = ts?.peers.find((p) => p.ips.includes(config.gateway.host) || p.name === config.gateway.host);
  const gwKey = localStorage.getItem(KEY_FLAG + 'gateway') === '1';

  return (
    <div className="app">
      <header>
        <h1>Tailscale Manager</h1>
        <div className="ts">
          <span className={`dot ${ts?.running ? 'on' : 'off'}`} />
          <span>
            Tailscale {ts ? (ts.running ? '켜짐' : ts.installed ? `꺼짐 (${ts.backendState})` : '설치 안 됨') : '…'}
          </span>
          {ts?.self && <span className="muted mono">{ts.self.ips[0]}</span>}
          <button className={ts?.running ? '' : 'primary'} disabled={!ts?.installed || tsBusy} onClick={toggleTailscale}>
            {tsBusy ? '처리 중…' : ts?.running ? '끄기' : '켜기'}
          </button>
        </div>
        <button className="ghost" onClick={() => setSettingsOpen(true)}>설정</button>
      </header>

      {link && (
        <div className="banner">
          <div>
            <b>외부 요청: {link.action}</b>
            <div className="muted mono">{Object.entries(link.params).map(([k, v]) => `${k}=${v}`).join('  ')}</div>
            <div className="muted">파일 올리기는 3단계(SFTP)에서 지원됩니다.</div>
          </div>
          <button className="ghost" onClick={() => setLink(null)}>닫기</button>
        </div>
      )}
      {ts?.error && <div className="banner bad">{ts.error}</div>}

      <main>
        <section className="col">
          <h2>울산 연결</h2>

          <div className="card">
            <div className="row">
              <div>
                <div className="title">
                  <span className={`dot ${gateway.connected ? 'on' : gwPeer?.online ? 'idle' : 'off'}`} />
                  {config.gateway.name}
                </div>
                <div className="muted mono">
                  {config.gateway.user}@{config.gateway.host}:{config.gateway.port}
                  {gwPeer && ` · Tailscale ${gwPeer.online ? '온라인' : '오프라인'}`}
                </div>
                {gateway.message && <div className="err">{gateway.message}</div>}
              </div>
              <span className="tag">경유지</span>
            </div>
            <div className="row sub">
              <span className="muted">
                {gwKey ? 'SSH 키 등록됨 · 비밀번호 없이 연결' : 'SSH 키를 등록하면 다음부터 비밀번호를 묻지 않습니다.'}
              </span>
              <button onClick={() => installKey('gateway', config.gateway.name)}>{gwKey ? '키 다시 등록' : 'SSH 키 등록'}</button>
            </div>
          </div>

          {config.tunnels.map((t) => {
            const s = states[t.id] ?? { id: t.id, phase: 'idle' };
            const open = s.phase === 'open';
            const keyed = localStorage.getItem(KEY_FLAG + t.id) === '1';
            return (
              <div className="card" key={t.id}>
                <div className="row">
                  <div>
                    <div className="title">
                      <span className={`dot ${open ? 'on' : s.phase === 'error' ? 'bad' : s.phase === 'connecting' ? 'idle' : 'off'}`} />
                      {t.name}
                    </div>
                    <div className="muted mono">
                      127.0.0.1:{t.local} → {t.host}:{t.port}
                    </div>
                    {s.phase === 'error' && <div className="err">{s.message}</div>}
                  </div>
                  <span className="tag">{t.kind === 'db' ? 'PostgreSQL' : 'SSH'}</span>
                </div>
                <div className="row sub">
                  <div className="btns">
                    {open ? (
                      <button onClick={() => api.stopTunnel(t.id)}>해제</button>
                    ) : (
                      <button className="primary" disabled={s.phase === 'connecting' || !ts?.running} onClick={() => connect(t)}>
                        {s.phase === 'connecting' ? '연결 중…' : '연결'}
                      </button>
                    )}
                    {t.kind === 'db' ? (
                      <>
                        <button onClick={() => runCheck(t)}>연결 테스트</button>
                        <button
                          onClick={() =>
                            copy(`jdbc:postgresql://127.0.0.1:${t.local}/${t.database ?? ''}`, 'JDBC 주소')
                          }
                        >
                          JDBC 복사
                        </button>
                        <button
                          onClick={() =>
                            copy(
                              `psql -h 127.0.0.1 -p ${t.local}${t.dbUser ? ` -U ${t.dbUser}` : ''}${t.database ? ` ${t.database}` : ''}`,
                              'psql 명령',
                            )
                          }
                        >
                          psql 복사
                        </button>
                      </>
                    ) : (
                      <>
                        <button onClick={() => copy(`ssh -p ${t.local} ${t.user}@127.0.0.1`, 'ssh 명령')}>ssh 명령 복사</button>
                        <button disabled={!gateway.connected} title={gateway.connected ? '' : '먼저 경유지에 연결하세요'} onClick={() => installKey(t.id, t.name)}>
                          {keyed ? '키 다시 등록' : 'SSH 키 등록'}
                        </button>
                      </>
                    )}
                  </div>
                  {t.kind === 'db' && (t.database || t.dbUser) && (
                    <span className="muted mono">
                      {t.database} {t.dbUser && `/ ${t.dbUser}`}
                    </span>
                  )}
                </div>
              </div>
            );
          })}
          {config.tunnels.length === 0 && <div className="empty">연결이 없습니다. 설정에서 추가하거나 기존 앱 설정을 가져오세요.</div>}
        </section>

        <section className="col side">
          <div className="row">
            <h2>Tailscale 노드</h2>
            <button className="ghost" onClick={refreshTs}>새로고침</button>
          </div>
          {ts?.self && <NodeRow p={ts.self} />}
          {ts?.peers.map((p) => <NodeRow key={p.name + p.ips[0]} p={p} gateway={p === gwPeer} />)}
          {ts && !ts.running && <div className="empty">Tailscale이 꺼져 있어 노드 목록을 볼 수 없습니다.</div>}
          {key && <div className="muted small">앱 SSH 키: {key.exists ? key.path : '아직 없음 (키 등록 시 자동 생성)'}</div>}
        </section>
      </main>

      <Modals prompt={prompt} check={check} onCloseCheck={() => setCheck(null)} />
      {settingsOpen && (
        <Settings
          config={config}
          onClose={() => setSettingsOpen(false)}
          onSaved={(c) => {
            setConfig(c);
            api.tunnelStates().then((s) => setStates(Object.fromEntries(s.tunnels.map((t) => [t.id, t]))));
            notify('설정을 저장했습니다.');
          }}
        />
      )}
      <div className="toasts">
        {toasts.map((t) => (
          <div key={t.id} className={`toast ${t.bad ? 'bad' : ''}`}>{t.msg}</div>
        ))}
      </div>
    </div>
  );
}

function NodeRow({ p, gateway }: { p: TailscaleStatus['peers'][number]; gateway?: boolean }) {
  return (
    <div className="node">
      <span className={`dot ${p.online ? 'on' : 'off'}`} />
      <div className="grow">
        <div>
          {p.name} {p.self && <span className="tag">내 PC</span>} {gateway && <span className="tag">경유지</span>}
        </div>
        <div className="muted mono small">
          {p.ips[0]} · {p.os}
          {!p.online && p.lastSeen && ` · 마지막 ${new Date(p.lastSeen).toLocaleString('ko-KR')}`}
        </div>
      </div>
    </div>
  );
}
