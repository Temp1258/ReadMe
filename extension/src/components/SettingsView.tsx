import { useEffect, useState } from 'react';
import type { UITheme, UILang } from '../types';
import type { TranslationKey } from '../i18n';
import { loadSettings, saveSettings, type SttProvider } from '../settings';

type SettingsViewProps = {
  uiTheme: UITheme;
  uiLang: UILang;
  t: (key: TranslationKey) => string;
  onThemeChange: (theme: UITheme) => void;
  onLanguageChange: (lang: UILang) => void;
  onOpenSettings: () => void;
};

const providerLabelMap: Record<SttProvider, string> = {
  openai: 'OpenAI Whisper',
  deepgram: 'Deepgram Nova-2',
  siliconflow: 'SiliconFlow',
  mock: 'Mock',
};

export function SettingsView({
  uiTheme,
  uiLang,
  t,
  onThemeChange,
  onLanguageChange,
  onOpenSettings,
}: SettingsViewProps) {
  const [provider, setProvider] = useState<SttProvider>('mock');
  const [providerConfigured, setProviderConfigured] = useState(false);
  const [summaryEnabled, setSummaryEnabled] = useState(false);

  const checkProviderConfigured = (settings: { stt: { provider: SttProvider; apiKey?: string; deepgramApiKey?: string; siliconflowApiKey?: string } }) => {
    const p = settings.stt.provider;
    if (p === 'openai') return Boolean(settings.stt.apiKey?.trim());
    if (p === 'deepgram') return Boolean(settings.stt.deepgramApiKey?.trim());
    if (p === 'siliconflow') return Boolean(settings.stt.siliconflowApiKey?.trim());
    return false;
  };

  useEffect(() => {
    loadSettings().then((settings) => {
      setProvider(settings.stt.provider);
      setProviderConfigured(checkProviderConfigured(settings));
      setSummaryEnabled(settings.ai?.summaryEnabled ?? false);
    });
  }, []);

  const handleProviderChange = async (newProvider: SttProvider) => {
    setProvider(newProvider);
    const settings = await loadSettings();
    const updated = { ...settings, stt: { ...settings.stt, provider: newProvider } };
    await saveSettings(updated);
    setProviderConfigured(checkProviderConfigured(updated));
  };

  const handleSummaryToggle = async () => {
    const next = !summaryEnabled;
    setSummaryEnabled(next);
    const settings = await loadSettings();
    await saveSettings({ ...settings, ai: { ...settings.ai, summaryEnabled: next } });
  };

  return (
    <section className="settings-view">
      <div className="settings-card">
        <h2>{t('appearance')}</h2>
        <div className="settings-toggle-row">
          <p className="panel__body">{t('appearance')}</p>
          <select
            className="form__input"
            value={uiTheme}
            onChange={(e) => onThemeChange(e.target.value as UITheme)}
          >
            <option value="light">{t('appearanceLight')}</option>
            <option value="dark">{t('appearanceDark')}</option>
          </select>
        </div>
        <div className="settings-toggle-row">
          <p className="panel__body">{t('language')}</p>
          <select
            className="form__input"
            value={uiLang}
            onChange={(e) => onLanguageChange(e.target.value as UILang)}
          >
            <option value="en">{t('languageEnglish')}</option>
            <option value="zh">{t('languageChinese')}</option>
          </select>
        </div>
      </div>

      <div className="settings-card">
        <h2>{t('providerSection')}</h2>
        <p className="panel__body">{t('providerStatus')}: {providerLabelMap[provider]} · {providerConfigured ? t('configured') : t('notConfigured')}</p>
        <select
          className="form__input"
          value={provider}
          onChange={(e) => void handleProviderChange(e.target.value as SttProvider)}
        >
          <option value="openai">{t('providerOpenai')}</option>
          <option value="deepgram">{t('providerDeepgram')}</option>
          <option value="siliconflow">{t('providerSiliconflow')}</option>
          <option value="mock">{t('providerMock')}</option>
        </select>

        <button className="button button--tertiary settings-link" onClick={onOpenSettings} type="button">
          {t('manageApi')}
        </button>
      </div>

      <div className="settings-card">
        <h2>{t('aiFeatures')}</h2>
        <div className="settings-toggle-row">
          <p className="panel__body">{t('aiSummaryToggle')}</p>
          <button
            className={`button button--secondary ${summaryEnabled ? 'button--selected' : ''}`}
            onClick={() => void handleSummaryToggle()}
            type="button"
          >
            {summaryEnabled ? 'ON' : 'OFF'}
          </button>
        </div>
      </div>

      <div className="warning-inline warning-inline--compact">
        <p>
          {t('warningOneLine')}
        </p>
      </div>

      <details className="settings-card">
        <summary>{t('privacySummary')}</summary>
        <p className="panel__body">{t('privacyBody')}</p>
      </details>
    </section>
  );
}
