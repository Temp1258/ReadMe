import type { UITheme, UILang } from '../types';
import type { TranslationKey } from '../i18n';

type SettingsViewProps = {
  uiTheme: UITheme;
  uiLang: UILang;
  sttStatusLine: string;
  t: (key: TranslationKey) => string;
  onThemeChange: (theme: UITheme) => void;
  onLanguageChange: (lang: UILang) => void;
  onOpenSettings: () => void;
};

export function SettingsView({
  uiTheme,
  uiLang,
  sttStatusLine,
  t,
  onThemeChange,
  onLanguageChange,
  onOpenSettings,
}: SettingsViewProps) {
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
        <p className="panel__body">{t('providerStatus')}: {sttStatusLine}</p>
        <button className="button button--tertiary settings-link" onClick={onOpenSettings} type="button">
          {t('manageApi')}
        </button>
      </div>

      <details className="settings-card">
        <summary>{t('privacySummary')}</summary>
        <p className="panel__body">{t('privacyBody')}</p>
      </details>
    </section>
  );
}
