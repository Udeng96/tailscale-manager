import type { Api } from '../electron/shared';

declare global {
  interface Window {
    api: Api;
  }
}

export const api = window.api;
export type * from '../electron/shared';
