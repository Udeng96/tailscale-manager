import { useState } from 'react';
import { api, type ApiError, type Result } from './api';

export type Prompt =
  | { kind: 'password'; title: string; error?: string; resolve: (pw: string | null) => void }
  | { kind: 'hostkey'; error: ApiError; resolve: (ok: boolean) => void };

/**
 * SSH가 필요한 작업을 실행하면서 비밀번호 입력, 서버 지문 확인을 화면에서 물어보고 다시 시도한다.
 */
export function useConnect(notify: (msg: string, bad?: boolean) => void) {
  const [prompt, setPrompt] = useState<Prompt | null>(null);

  const askPassword = (title: string, error?: string) =>
    new Promise<string | null>((resolve) => setPrompt({ kind: 'password', title, error, resolve: (v) => (setPrompt(null), resolve(v)) }));
  const askHostKey = (error: ApiError) =>
    new Promise<boolean>((resolve) => setPrompt({ kind: 'hostkey', error, resolve: (v) => (setPrompt(null), resolve(v)) }));

  async function run<T>(title: string, call: (pw?: string) => Promise<Result<T>>, firstPassword?: string): Promise<T | null> {
    let pw = firstPassword;
    for (let i = 0; i < 6; i++) {
      const r = await call(pw);
      if (r.ok) return r.value;
      const e = r.error;
      if (e.code === 'NEED_PASSWORD' || e.code === 'AUTH_FAILED') {
        const next = await askPassword(title, e.code === 'AUTH_FAILED' ? e.message : undefined);
        if (next === null) return null;
        pw = next;
        continue;
      }
      if (e.code === 'HOST_KEY_UNKNOWN' && e.hostKeyId && e.fingerprint) {
        if (!(await askHostKey(e))) return null;
        await api.trustHostKey(e.hostKeyId, e.fingerprint);
        continue;
      }
      if (e.code === 'HOST_KEY_CHANGED') {
        await askHostKey(e);
        return null;
      }
      notify(e.message, true);
      return null;
    }
    return null;
  }

  return { prompt, run, askPassword };
}
