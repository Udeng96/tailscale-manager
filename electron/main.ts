import { app, BrowserWindow, ipcMain, shell } from 'electron';
import path from 'node:path';
import { DATA_DIR, importUlsanConnect, loadConfig, saveConfig } from './core/config';
import { Services } from './core/services';
import { toApiError } from './core/ssh';
import { getStatus, setRunning } from './core/tailscale';
import { findDeepLinkArg, parseDeepLink, SCHEME } from './deeplink';
import type { AppConfig, DeepLink, Result } from './shared';

let config: AppConfig = loadConfig();
const services = new Services(DATA_DIR, () => config);
let win: BrowserWindow | null = null;
let pendingLink: DeepLink | null = null;

async function wrap<T>(fn: () => Promise<T> | T): Promise<Result<T>> {
  try {
    return { ok: true, value: await fn() };
  } catch (e) {
    return { ok: false, error: toApiError(e) };
  }
}

function deliverLink(url: string | undefined) {
  const link = url ? parseDeepLink(url) : null;
  if (!link) return;
  if (win && !win.webContents.isLoading()) {
    win.webContents.send('deeplink', link);
    if (win.isMinimized()) win.restore();
    win.focus();
  } else {
    pendingLink = link;
  }
}

// 개발 중(electron .)에는 실행 파일 경로를 함께 등록해야 링크가 이 앱으로 온다
if (process.defaultApp && process.argv[1]) {
  app.setAsDefaultProtocolClient(SCHEME, process.execPath, [path.resolve(process.argv[1])]);
} else {
  app.setAsDefaultProtocolClient(SCHEME);
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', (_e, argv) => deliverLink(findDeepLinkArg(argv)));
  app.on('open-url', (e, url) => {
    e.preventDefault();
    deliverLink(url);
  });
  app.whenReady().then(() => {
    registerIpc();
    createWindow();
    deliverLink(findDeepLinkArg(process.argv));
  });
}

function createWindow() {
  win = new BrowserWindow({
    width: 1180,
    height: 820,
    minWidth: 900,
    minHeight: 600,
    title: 'Tailscale Manager',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('did-finish-load', () => {
    if (pendingLink) win?.webContents.send('deeplink', pendingLink);
    pendingLink = null;
  });
  const devUrl = process.env.VITE_DEV_SERVER_URL;
  if (devUrl) win.loadURL(devUrl);
  else win.loadFile(path.join(__dirname, '..', 'dist', 'index.html'));
  win.on('closed', () => (win = null));
}

function registerIpc() {
  services.tunnels.on('change', (snap) => win?.webContents.send('tunnel:changed', snap));

  ipcMain.handle('config:get', () => config);
  ipcMain.handle('config:save', (_e, next: AppConfig) =>
    wrap(() => {
      config = saveConfig(next);
      return config;
    }),
  );
  ipcMain.handle('config:importUlsan', () =>
    wrap(() => {
      config = saveConfig(importUlsanConnect(config));
      return config;
    }),
  );

  ipcMain.handle('tailscale:status', () => getStatus());
  ipcMain.handle('tailscale:up', () => wrap(() => setRunning(true)));
  ipcMain.handle('tailscale:down', () =>
    wrap(() => {
      // Tailscale을 끄면 경유지에 닿지 않으므로 터널부터 정리한다
      services.tunnels.stopAll();
      return setRunning(false);
    }),
  );

  ipcMain.handle('tunnel:states', () => services.tunnels.snapshot());
  ipcMain.handle('tunnel:start', (_e, id: string, password?: string) => wrap(() => services.tunnels.start(id, password)));
  ipcMain.handle('tunnel:stop', (_e, id: string) => services.tunnels.stop(id));
  ipcMain.handle('hostkey:trust', (_e, hostKeyId: string, fp: string) => services.hostKeys.trust(hostKeyId, fp));
  ipcMain.handle('db:check', (_e, id: string) => services.checkDb(id));

  ipcMain.handle('key:status', () => services.keys.status());
  ipcMain.handle('key:generate', () => wrap(() => services.keys.generate()));
  ipcMain.handle('key:install', (_e, target: string, password: string) => wrap(() => services.installKey(target, password)));
}

app.on('before-quit', () => services.tunnels.stopAll());
app.on('window-all-closed', () => {
  services.tunnels.stopAll();
  app.quit();
});
