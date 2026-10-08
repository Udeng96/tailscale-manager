import { useState } from 'react';
import type { CheckStep } from './api';
import type { Prompt } from './useConnect';

export function Modals({
  prompt,
  check,
  onCloseCheck,
}: {
  prompt: Prompt | null;
  check: { name: string; steps: CheckStep[] | null } | null;
  onCloseCheck: () => void;
}) {
  if (prompt?.kind === 'password') return <PasswordModal key={prompt.title + prompt.error} prompt={prompt} />;
  if (prompt?.kind === 'hostkey') {
    const changed = prompt.error.code === 'HOST_KEY_CHANGED';
    return (
      <div className="overlay">
        <div className="modal">
          <h3>{changed ? '서버 지문이 바뀌었습니다' : '처음 접속하는 서버'}</h3>
          <p>{prompt.error.message}</p>
          <div className="mono box">{prompt.error.fingerprint}</div>
          {changed ? (
            <>
              <p className="muted">서버를 다시 설치한 게 아니라면 연결하지 마세요. 설정 폴더의 known_hosts.json에서 해당 항목을 지우면 다시 확인할 수 있습니다.</p>
              <div className="actions">
                <button className="primary" onClick={() => prompt.resolve(false)}>닫기</button>
              </div>
            </>
          ) : (
            <div className="actions">
              <button onClick={() => prompt.resolve(false)}>취소</button>
              <button className="primary" onClick={() => prompt.resolve(true)}>신뢰하고 연결</button>
            </div>
          )}
        </div>
      </div>
    );
  }
  if (check) {
    return (
      <div className="overlay" onClick={onCloseCheck}>
        <div className="modal" onClick={(e) => e.stopPropagation()}>
          <h3>{check.name} 연결 테스트</h3>
          {!check.steps && <p className="muted">확인 중…</p>}
          {check.steps?.map((s) => (
            <div key={s.label} className="step">
              <span className={`dot ${s.ok ? 'on' : 'bad'}`} />
              <b>{s.label}</b>
              <span className="muted">{s.detail}</span>
            </div>
          ))}
          <div className="actions">
            <button className="primary" onClick={onCloseCheck}>닫기</button>
          </div>
        </div>
      </div>
    );
  }
  return null;
}

function PasswordModal({ prompt }: { prompt: Extract<Prompt, { kind: 'password' }> }) {
  const [pw, setPw] = useState('');
  return (
    <div className="overlay">
      <form
        className="modal"
        onSubmit={(e) => {
          e.preventDefault();
          if (pw) prompt.resolve(pw);
        }}
      >
        <h3>{prompt.title}</h3>
        {prompt.error && <div className="err">{prompt.error}</div>}
        <input type="password" autoFocus value={pw} onChange={(e) => setPw(e.target.value)} placeholder="비밀번호" />
        <p className="muted small">비밀번호는 저장하지 않습니다.</p>
        <div className="actions">
          <button type="button" onClick={() => prompt.resolve(null)}>취소</button>
          <button type="submit" className="primary" disabled={!pw}>확인</button>
        </div>
      </form>
    </div>
  );
}
