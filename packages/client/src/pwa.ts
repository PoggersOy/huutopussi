/**
 * PWA service-worker registration (vite-plugin-pwa, registerType 'prompt').
 * A waiting update never reloads the page by itself — mid-game reloads are
 * forbidden — it surfaces as an 'update' toast whose button calls applyUpdate.
 *
 * Note for tests: 'virtual:pwa-register' only exists when the Vite PWA plugin
 * is active; vitest.config.ts aliases it to test/stubs/pwa-register.ts.
 */
import { registerSW } from 'virtual:pwa-register';
import { useStore } from './store';

let doUpdate: ((reloadPage?: boolean) => Promise<void>) | null = null;

export function initPwa(): void {
  doUpdate = registerSW({
    onNeedRefresh() {
      useStore.getState().pushToast({ kind: 'update', code: 'pwa.updateAvailable' });
    },
    onOfflineReady() {
      useStore.getState().pushToast({ kind: 'info', code: 'pwa.offlineReady' });
    },
  });
}

/** Activate the waiting service worker and reload (update-toast button). */
export function applyUpdate(): void {
  void doUpdate?.(true);
}
