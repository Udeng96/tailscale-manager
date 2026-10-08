import { contextBridge, ipcRenderer } from 'electron';
import type { Api } from './shared';

const invoke = (ch: string) => (...args: unknown[]) => ipcRenderer.invoke(ch, ...args);

function subscribe<T>(channel: string, cb: (v: T) => void) {
  const handler = (_: unknown, v: T) => cb(v);
  ipcRenderer.on(channel, handler);
  return () => {
    ipcRenderer.removeListener(channel, handler);
  };
}

const api: Api = {
  getConfig: invoke('config:get') as Api['getConfig'],
  saveConfig: invoke('config:save') as Api['saveConfig'],
  importUlsanConnect: invoke('config:importUlsan') as Api['importUlsanConnect'],
  tailscaleStatus: invoke('tailscale:status') as Api['tailscaleStatus'],
  tailscaleUp: invoke('tailscale:up') as Api['tailscaleUp'],
  tailscaleDown: invoke('tailscale:down') as Api['tailscaleDown'],
  tunnelStates: invoke('tunnel:states') as Api['tunnelStates'],
  startTunnel: invoke('tunnel:start') as Api['startTunnel'],
  stopTunnel: invoke('tunnel:stop') as Api['stopTunnel'],
  trustHostKey: invoke('hostkey:trust') as Api['trustHostKey'],
  checkDb: invoke('db:check') as Api['checkDb'],
  keyStatus: invoke('key:status') as Api['keyStatus'],
  generateKey: invoke('key:generate') as Api['generateKey'],
  installKey: invoke('key:install') as Api['installKey'],
  onTunnelStates: (cb) => subscribe('tunnel:changed', cb),
  onDeepLink: (cb) => subscribe('deeplink', cb),
};

contextBridge.exposeInMainWorld('api', api);
