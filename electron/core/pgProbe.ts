import net from 'node:net';

export type PgProbeResult = { ok: true; ssl: boolean } | { ok: false; reason: string };

/**
 * 로그인 없이 PostgreSQL이 응답하는지 확인한다.
 * SSLRequest(8바이트)를 보내면 PostgreSQL은 'S' 또는 'N' 한 바이트로 답한다.
 */
export function probePostgres(host: string, port: number, timeoutMs = 5000): Promise<PgProbeResult> {
  return new Promise((resolve) => {
    const sock = net.connect({ host, port });
    let done = false;
    const finish = (r: PgProbeResult) => {
      if (done) return;
      done = true;
      sock.destroy();
      resolve(r);
    };
    sock.setTimeout(timeoutMs, () => finish({ ok: false, reason: `${timeoutMs / 1000}초 동안 응답이 없습니다.` }));
    sock.on('error', (e: NodeJS.ErrnoException) =>
      finish({ ok: false, reason: e.code === 'ECONNREFUSED' ? '포트가 열려 있지 않습니다.' : e.message }),
    );
    sock.on('connect', () => {
      const req = Buffer.alloc(8);
      req.writeInt32BE(8, 0);
      req.writeInt32BE(80877103, 4);
      sock.write(req);
    });
    sock.on('data', (d: Buffer) => {
      const c = String.fromCharCode(d[0]);
      if (c === 'S' || c === 'N') finish({ ok: true, ssl: c === 'S' });
      else finish({ ok: false, reason: 'PostgreSQL이 아닌 다른 프로그램이 응답했습니다.' });
    });
    sock.on('close', () => finish({ ok: false, reason: '응답 없이 연결이 끊겼습니다.' }));
  });
}
