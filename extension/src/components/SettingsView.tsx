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
          <div className="inline-actions">
            <button
              className={`button button--secondary ${uiTheme === 'light' ? 'button--selected' : ''}`}
              onClick={() => onThemeChange('light')}
              type="button"
            >
              {t('appearanceLight')}
            </button>
            <button
              className={`button button--secondary ${uiTheme === 'dark' ? 'button--selected' : ''}`}
              onClick={() => onThemeChange('dark')}
              type="button"
            >
              {t('appearanceDark')}
            </button>
          </div>
        </div>
        <div className="settings-toggle-row">
          <p className="panel__body">{t('language')}</p>
          <div className="inline-actions">
            <button
              className={`button button--secondary ${uiLang === 'en' ? 'button--selected' : ''}`}
              onClick={() => onLanguageChange('en')}
              type="button"
            >
              {t('languageEnglish')}
            </button>
            <button
              className={`button button--secondary ${uiLang === 'zh' ? 'button--selected' : ''}`}
              onClick={() => onLanguageChange('zh')}
              type="button"
            >
              {t('languageChinese')}
            </button>
          </div>
        </div>
      </div>

      <div className="settings-card">
        <h2>{t('providerSection')}</h2>
        <p className="panel__body">{t('providerStatus')}: {providerLabelMap[provider]} · {providerConfigured ? t('configured') : t('notConfigured')}</p>
        <div className="settings-toggle-row">
          <p className="panel__body">{t('source')}</p>
          <div className="inline-actions">
            <button
              className={`button button--secondary ${provider === 'openai' ? 'button--selected' : ''}`}
              onClick={() => void handleProviderChange('openai')}
              type="button"
            >
              {t('providerOpenai')}
            </button>
            <button
              className={`button button--secondary ${provider === 'deepgram' ? 'button--selected' : ''}`}
              onClick={() => void handleProviderChange('deepgram')}
              type="button"
            >
              {t('providerDeepgram')}
            </button>
            <button
              className={`button button--secondary ${provider === 'siliconflow' ? 'button--selected' : ''}`}
              onClick={() => void handleProviderChange('siliconflow')}
              type="button"
            >
              {t('providerSiliconflow')}
            </button>
            <button
              className={`button button--secondary ${provider === 'mock' ? 'button--selected' : ''}`}
              onClick={() => void handleProviderChange('mock')}
              type="button"
            >
              {t('providerMock')}
            </button>
          </div>
        </div>

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

      <details className="settings-card">
        <summary>{t('privacySummary')}</summary>
        <p className="panel__body">{t('privacyBody')}</p>
      </details>
    </section>
  );
}
