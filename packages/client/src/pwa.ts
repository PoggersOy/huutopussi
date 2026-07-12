/**
 * PWA service-worker registration (vite-plugin-pwa, registerType 'prompt').
 *
 * A new build is picked up as fast and reliably as service workers allow:
 *  - we poll `r.update()` (every minute + on every foreground) so a deploy is
 *    detected promptly instead of waiting for the browser's own lazy check —
 *    which an installed iOS PWA may only run on a cold relaunch;
 *  - when the new worker is ready we auto-apply it **only when it's safe**
 *    (the player is not at a live table): no reloads mid-game, ever. During a
 *    game we show the 'update' toast instead and then auto-apply the moment the
 *    player leaves the table, so nobody is stranded on a stale build.
 *
 * Note for tests: 'virtual:pwa-register' only exists when the Vite PWA plugin
 * is active; vitest.config.ts aliases it to test/stubs/pwa-register.ts.
 */
import { registerSW } from 'virtual:pwa-register';
import { useStore } from './store';

let doUpdate: ((reloadPage?: boolean) => Promise<void>) | null = null;

/** How often to poll for a fresh service worker (a conditional GET of sw.js). */
const UPDATE_POLL_MS = 60_000;

/**
 * True while the player is at a live table (a redacted `PlayerView` is present —
 * see Table.tsx, which renders the felt only when `view !== null`). Home, the
 * lobby, history and the rules screens all have `view === null` and are safe to
 * reload under the player's feet.
 */
function atLiveTable(): boolean {
  return useStore.getState().server.view !== null;
}

export function initPwa(): void {
  let applied = false;

  // Activate the waiting worker and reload — but never while at a live table.
  // If we're mid-game, defer: watch the store and apply as soon as the player
  // returns to a `view === null` screen (left the table / match ended).
  const applyWhenSafe = (): void => {
    if (applied) return;
    if (atLiveTable()) {
      const unsubscribe = useStore.subscribe((s) => {
        if (s.server.view === null) {
          unsubscribe();
          applyWhenSafe();
        }
      });
      return;
    }
    applied = true;
    applyUpdate();
  };

  doUpdate = registerSW({
    // The browser's own SW update check is lazy — especially in an installed
    // iOS PWA, which may only re-check on a cold relaunch. Poll actively (and
    // whenever the app is foregrounded) so a new deploy is detected within a
    // minute. `r.update()` is a cheap conditional fetch of sw.js (served
    // `no-cache`, so it always revalidates).
    onRegisteredSW(_swUrl, r) {
      if (!r) return;
      const check = (): void => {
        void r.update();
      };
      setInterval(check, UPDATE_POLL_MS);
      if (typeof document !== 'undefined') {
        document.addEventListener('visibilitychange', () => {
          if (document.visibilityState === 'visible') check();
        });
      }
    },
    onNeedRefresh() {
      // Off the table → update silently now. At a live table → surface the toast
      // (manual "Päivitä") and also auto-apply once the player leaves.
      if (atLiveTable()) {
        useStore.getState().pushToast({ kind: 'update', code: 'pwa.updateAvailable' });
      }
      applyWhenSafe();
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
 * here (never on registration) preserves the "no reload mid-game" rule: this is
 * only ever called from the update toast tap or from `applyWhenSafe`, which has
 * already confirmed the player is not at a live table.
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
