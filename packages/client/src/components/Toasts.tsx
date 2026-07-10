import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { applyUpdate } from '../pwa';
import { useStore } from '../store';

const AUTO_DISMISS_MS = 4_000;

/** Toast queue overlay. 'update' toasts stick until acted on; others fade. */
export function Toasts() {
  const { t } = useTranslation();
  const toasts = useStore((s) => s.ui.toasts);
  const dismissToast = useStore((s) => s.dismissToast);

  useEffect(() => {
    const timers = toasts
      .filter((toast) => toast.kind !== 'update')
      .map((toast) => setTimeout(() => dismissToast(toast.id), AUTO_DISMISS_MS));
    return () => {
      for (const timer of timers) clearTimeout(timer);
    };
  }, [toasts, dismissToast]);

  if (toasts.length === 0) return null;
  return (
    <div className="toasts">
      {toasts.map((toast) => (
        <div key={toast.id} className={`toast toast--${toast.kind}`}>
          <span>{t(toast.code, toast.params ?? {})}</span>
          {toast.kind === 'update' ? (
            <button type="button" className="btn--primary" onClick={() => applyUpdate()}>
              {t('pwa.reload')}
            </button>
          ) : (
            <button
              type="button"
              className="btn--ghost"
              aria-label={t('common.close')}
              onClick={() => dismissToast(toast.id)}
            >
              ✕
            </button>
          )}
        </div>
      ))}
    </div>
  );
}
