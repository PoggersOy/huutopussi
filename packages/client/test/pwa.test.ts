/**
 * Regression for the dead "Uusi versio saatavilla → Päivitä" button.
 *
 * vite-plugin-pwa reloads on its `controlling` event only when
 * `event.isUpdate` is truthy, and that flag is `!!navigator.serviceWorker.
 * controller` sampled at registration. A page loaded uncontrolled (e.g. after
 * a hard refresh, which bypasses the SW) has no controller, so the plugin's
 * reload never runs — the tap sent skip-waiting but nothing happened.
 * applyUpdate must reload on its own in that case.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('applyUpdate (PWA update button)', () => {
  let reload: ReturnType<typeof vi.fn>;
  let controllerChangeListeners: EventListener[];

  beforeEach(() => {
    vi.resetModules();
    vi.useFakeTimers();

    reload = vi.fn();
    // jsdom's location.reload throws "Not implemented"; swap in a spy.
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: { reload },
    });

    controllerChangeListeners = [];
    const fakeServiceWorker = {
      addEventListener: (type: string, cb: EventListener) => {
        if (type === 'controllerchange') controllerChangeListeners.push(cb);
      },
    };
    Object.defineProperty(navigator, 'serviceWorker', {
      configurable: true,
      value: fakeServiceWorker,
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    Reflect.deleteProperty(navigator, 'serviceWorker');
  });

  it('reloads when the new worker takes control (controllerchange)', async () => {
    const { initPwa, applyUpdate } = await import('../src/pwa');
    initPwa();

    applyUpdate();
    expect(reload).not.toHaveBeenCalled();

    for (const cb of controllerChangeListeners) cb(new Event('controllerchange'));
    expect(reload).toHaveBeenCalledTimes(1);

    // The fallback timer must not fire a second reload.
    vi.advanceTimersByTime(5_000);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('reloads via fallback when the page is uncontrolled and controllerchange never fires', async () => {
    const { initPwa, applyUpdate } = await import('../src/pwa');
    initPwa();

    applyUpdate();
    expect(reload).not.toHaveBeenCalled();

    vi.advanceTimersByTime(2_000);
    expect(reload).toHaveBeenCalledTimes(1);
  });
});
