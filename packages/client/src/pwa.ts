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

/**
 * How long to wait for the freshly activated worker to claim this client before
 * reloading regardless. Covers pages that loaded *uncontrolled* (see
 * {@link applyUpdate}), where `controllerchange` never fires.
 */
const RELOAD_FALLBACK_MS = 2_000;

/**
 * Activate the waiting service worker and reload onto the new version.
 *
 * We own the reload here rather than leaving it to vite-plugin-pwa. The plugin
 * reloads on its `controlling` event only when `event.isUpdate` is truthy, and
 * that flag is `!!navigator.serviceWorker.controller` sampled at registration.
 * A page that loaded *uncontrolled* — e.g. right after a hard refresh, which
 * bypasses the service worker — has no controller, so the plugin's reload
 * silently no-ops: skip-waiting is sent and the worker activates, but the page
 * never reloads and the "Päivitä" button looks dead. Arming the reload only
 * inside this click handler (never on registration) preserves the "no reload
 * mid-game" rule — it fires solely when the user taps the update toast.
 */
export function applyUpdate(): void {
  if (doUpdate === null) return;
  const sw = typeof navigator !== 'undefined' ? navigator.serviceWorker : undefined;
  if (sw !== undefined) {
    let reloaded = false;
    const reload = () => {
      if (reloaded) return;
      reloaded = true;
      window.location.reload();
    };
    // Fast path: the new worker claiming an already-controlled client fires
    // controllerchange the moment skip-waiting activates it.
    sw.addEventListener('controllerchange', reload, { once: true });
    // Fallback for an uncontrolled client, where controllerchange never comes.
    window.setTimeout(reload, RELOAD_FALLBACK_MS);
  }
  void doUpdate(true);
}
