import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';

// 개발 서버는 HMR용 인라인 스크립트가 필요해서 CSP는 빌드 결과에만 넣는다
const csp = (): Plugin => ({
  name: 'csp',
  apply: 'build',
  transformIndexHtml: (html) =>
    html.replace(
      '<head>',
      `<head>\n    <meta http-equiv="Content-Security-Policy" content="default-src 'self'; style-src 'self' 'unsafe-inline'" />`,
    ),
});

export default defineConfig({
  plugins: [react(), csp()],
  base: './',
  build: { outDir: 'dist', emptyOutDir: true },
  server: { port: 5173, strictPort: true },
});
