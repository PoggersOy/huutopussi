/**
 * PWA install-prompt affordance: Chromium fires 'beforeinstallprompt' when the
 * app is installable; we defer it and surface a subtle install button on Home
 * (docs/plan.md §6 — no aggressive banners). Tiny external store so React can
 * subscribe via useSyncExternalStore.
 */

interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

let deferred: BeforeInstallPromptEvent | null = null;
let installed = false;
const listeners = new Set<() => void>();

function notify(): void {
  for (const listener of listeners) listener();
}

/** Capture install prompts. Idempotent; call once at app startup. */
export function initInstallPrompt(): void {
  if (installed || typeof window === 'undefined') return;
  installed = true;
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault(); // suppress the mini-infobar; we show our own button
    deferred = e as BeforeInstallPromptEvent;
    notify();
  });
  window.addEventListener('appinstalled', () => {
    deferred = null;
    notify();
  });
}

export function subscribeInstall(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** True while a deferred install prompt is waiting to be shown. */
export function installAvailable(): boolean {
  return deferred !== null;
}

/** Show the browser install dialog (install-button click handler). */
export async function promptInstall(): Promise<void> {
  const evt = deferred;
  if (evt === null) return;
  deferred = null; // a BeforeInstallPromptEvent can only be used once
  notify();
  try {
    await evt.prompt();
    await evt.userChoice;
  } catch {
    // Dialog dismissed or prompt() re-invoked — nothing to do.
  }
}
