/**
 * RuleConfigsPanel — the profile section where a signed-in player manages their
 * saved rule configurations (the lobby "Sääntömuoto" dropdown beyond the
 * built-in "Oletus"). Lists them, and opens a full-field editor sheet to create
 * or edit one (capped at MAX_RULE_CONFIGS). All rules authority stays on the
 * engine/server; this only stores a config the host later picks in a lobby.
 */
import type { RuleConfig } from '@hp/engine';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  type ConfigMutationResult,
  createRuleConfig,
  deleteRuleConfig,
  MAX_RULE_CONFIGS,
  updateRuleConfig,
} from '../ruleConfigs';
import { DEFAULT_CONFIG, RuleConfigEditor, ruleConfigError } from '../rules';
import { syncRuleConfigs, useStore } from '../store';

type Draft = { id: string | null; name: string; config: RuleConfig };

const MUTATION_ERROR_KEY: Record<Exclude<ConfigMutationResult, { ok: true }>['error'], string> = {
  limit: 'config.errLimit',
  invalid: 'config.errInvalid',
  unauthorized: 'config.errUnauthorized',
  network: 'config.errNetwork',
};

export function RuleConfigsPanel() {
  const { t } = useTranslation();
  const configs = useStore((s) => s.auth.ruleConfigs);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);

  // Refresh from the server on mount so the list is current even if the account
  // saved configs in another tab/session since sign-in.
  useEffect(() => {
    void syncRuleConfigs();
  }, []);

  const atLimit = configs.length >= MAX_RULE_CONFIGS;

  return (
    <div className="panel stack">
      <h2>{t('config.savedTitle')}</h2>
      <p className="dim">{t('config.savedIntro', { max: MAX_RULE_CONFIGS })}</p>

      {configs.length > 0 ? (
        <ul className="list">
          {configs.map((c) => (
            <li key={c.id} className="config-list__row">
              <span className="config-list__name">{c.name}</span>
              <div className="row" style={{ gap: 'var(--space-2)' }}>
                <button
                  type="button"
                  className="btn--ghost"
                  onClick={() => setDraft({ id: c.id, name: c.name, config: c.config })}
                >
                  {t('common.edit')}
                </button>
                {confirmDeleteId === c.id ? (
                  <>
                    <button
                      type="button"
                      className="btn--danger"
                      onClick={() => {
                        void deleteRuleConfig(c.id);
                        setConfirmDeleteId(null);
                      }}
                    >
                      {t('config.deleteConfirm')}
                    </button>
                    <button
                      type="button"
                      className="btn--ghost"
                      onClick={() => setConfirmDeleteId(null)}
                    >
                      {t('common.cancel')}
                    </button>
                  </>
                ) : (
                  <button
                    type="button"
                    className="btn--ghost"
                    onClick={() => setConfirmDeleteId(c.id)}
                  >
                    {t('common.delete')}
                  </button>
                )}
              </div>
            </li>
          ))}
        </ul>
      ) : (
        <p className="dim">{t('config.savedEmpty')}</p>
      )}

      <button
        type="button"
        className="btn--ghost"
        disabled={atLimit}
        onClick={() => setDraft({ id: null, name: '', config: DEFAULT_CONFIG })}
      >
        {t('config.createNew')}
      </button>
      {atLimit && <p className="dim">{t('config.errLimit')}</p>}

      {draft !== null && <ConfigEditorSheet draft={draft} onClose={() => setDraft(null)} />}
    </div>
  );
}

/** The create/edit sheet: a name field + the full RuleConfigEditor + Save. */
function ConfigEditorSheet({ draft, onClose }: { draft: Draft; onClose: () => void }) {
  const { t } = useTranslation();
  const [name, setName] = useState(draft.name);
  const [config, setConfig] = useState<RuleConfig>(draft.config);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const save = async (): Promise<void> => {
    const trimmed = name.trim();
    if (trimmed.length === 0) {
      setError('config.errName');
      return;
    }
    const invalid = ruleConfigError(config);
    if (invalid !== null) {
      setError(invalid);
      return;
    }
    setSaving(true);
    const result =
      draft.id === null
        ? await createRuleConfig(trimmed, config)
        : await updateRuleConfig(draft.id, trimmed, config);
    setSaving(false);
    if (result.ok) {
      onClose();
      return;
    }
    setError(MUTATION_ERROR_KEY[result.error]);
  };

  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: dismiss via the Cancel button; backdrop is a touch affordance
    <div
      className="rules-overlay"
      role="dialog"
      aria-modal="true"
      onClick={(e) => {
        if (e.target === e.currentTarget && !saving) onClose();
      }}
    >
      <div className="rules-overlay__panel stack">
        <h2>{draft.id === null ? t('config.createNew') : t('common.edit')}</h2>
        <label className="stack">
          <span className="dim">{t('config.name')}</span>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={40}
            placeholder={t('config.namePlaceholder')}
          />
        </label>
        <RuleConfigEditor value={config} onChange={setConfig} />
        {error !== null && <p className="dim">{t(error)}</p>}
        <div className="row" style={{ gap: 'var(--space-2)' }}>
          <button type="button" className="btn--ghost" onClick={onClose} disabled={saving}>
            {t('common.cancel')}
          </button>
          <button
            type="button"
            className="btn--primary"
            onClick={() => void save()}
            disabled={saving}
          >
            {saving ? t('common.loading') : t('common.save')}
          </button>
        </div>
      </div>
    </div>
  );
}
