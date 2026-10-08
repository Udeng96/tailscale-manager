import { useState } from 'react';
import { api, type AppConfig, type Tunnel } from './api';

const newId = () => Math.random().toString(16).slice(2, 14);

export function Settings({ config, onClose, onSaved }: { config: AppConfig; onClose: () => void; onSaved: (c: AppConfig) => void }) {
  const [draft, setDraft] = useState<AppConfig>(structuredClone(config));
  const [error, setError] = useState<string | null>(null);

  const setGw = (k: keyof AppConfig['gateway'], v: string) =>
    setDraft((d) => ({ ...d, gateway: { ...d.gateway, [k]: k === 'port' ? Number(v) : v } }));
  const setT = (i: number, k: keyof Tunnel, v: string) =>
    setDraft((d) => {
      const tunnels = [...d.tunnels];
      tunnels[i] = { ...tunnels[i], [k]: k === 'port' || k === 'local' ? Number(v) : v };
      return { ...d, tunnels };
    });

  async function save() {
    const r = await api.saveConfig(draft);
    if (!r.ok) return setError(r.error.message);
    onSaved(r.value);
    onClose();
  }

  async function importOld() {
    const r = await api.importUlsanConnect();
    if (!r.ok) return setError(r.error.message);
    setDraft(structuredClone(r.value));
    setError(null);
    onSaved(r.value);
  }

  return (
    <div className="overlay">
      <div className="modal wide">
        <div className="row">
          <h3>설정</h3>
          <button onClick={importOld}>기존 "울산 연결" 앱 설정 가져오기</button>
        </div>
        {error && <div className="err">{error}</div>}

        <h4>경유지 (울산 Windows PC)</h4>
        <div className="grid gw">
          <label>이름<input value={draft.gateway.name} onChange={(e) => setGw('name', e.target.value)} /></label>
          <label>Tailscale IP<input value={draft.gateway.host} onChange={(e) => setGw('host', e.target.value)} /></label>
          <label>포트<input type="number" value={draft.gateway.port} onChange={(e) => setGw('port', e.target.value)} /></label>
          <label>계정<input value={draft.gateway.user} onChange={(e) => setGw('user', e.target.value)} /></label>
        </div>

        <h4>연결 목록</h4>
        <div className="grid head">
          <span>이름</span><span>종류</span><span>내부망 주소</span><span>포트</span><span>내 PC 포트</span><span>계정 / DB명</span><span />
        </div>
        {draft.tunnels.map((t, i) => (
          <div className="grid" key={t.id}>
            <input value={t.name} onChange={(e) => setT(i, 'name', e.target.value)} />
            <select value={t.kind} onChange={(e) => setT(i, 'kind', e.target.value)}>
              <option value="db">DB</option>
              <option value="ssh">SSH</option>
            </select>
            <input value={t.host} onChange={(e) => setT(i, 'host', e.target.value)} />
            <input type="number" value={t.port} onChange={(e) => setT(i, 'port', e.target.value)} />
            <input type="number" value={t.local} onChange={(e) => setT(i, 'local', e.target.value)} />
            {t.kind === 'ssh' ? (
              <input placeholder="로그인 계정" value={t.user} onChange={(e) => setT(i, 'user', e.target.value)} />
            ) : (
              <div className="pair">
                <input placeholder="DB명" value={t.database ?? ''} onChange={(e) => setT(i, 'database', e.target.value)} />
                <input placeholder="DB 계정" value={t.dbUser ?? ''} onChange={(e) => setT(i, 'dbUser', e.target.value)} />
              </div>
            )}
            <button className="ghost" onClick={() => setDraft((d) => ({ ...d, tunnels: d.tunnels.filter((_, j) => j !== i) }))}>삭제</button>
          </div>
        ))}
        <button
          className="ghost"
          onClick={() =>
            setDraft((d) => ({
              ...d,
              tunnels: [...d.tunnels, { id: newId(), name: '', host: '10.10.11.', port: 22, local: 10000, user: '', kind: 'ssh' }],
            }))
          }
        >
          + 연결 추가
        </button>

        <div className="actions">
          <button onClick={onClose}>닫기</button>
          <button className="primary" onClick={save}>저장</button>
        </div>
      </div>
    </div>
  );
}
