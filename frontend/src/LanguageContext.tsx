import { createContext, useContext, useState, useEffect, useCallback, type ReactNode } from 'react';
import en from './i18n/en.json';
import zhTW from './i18n/zh-TW.json';

export type Language = 'en' | 'zh-TW';

const translations: Record<Language, Record<string, string>> = {
  'en': en,
  'zh-TW': zhTW,
};

interface LanguageContextValue {
  language: Language;
  setLanguage: (lang: Language) => void;
  t: (key: string, params?: Record<string, string | number>) => string;
}

const LanguageContext = createContext<LanguageContextValue | null>(null);

function getInitialLanguage(): Language {
  const stored = localStorage.getItem('language');
  if (stored === 'en' || stored === 'zh-TW') return stored;
  if (navigator.language.startsWith('zh')) return 'zh-TW';
  return 'en';
}

export function LanguageProvider({ children }: { children: ReactNode }) {
  const [language, setLanguageState] = useState<Language>(getInitialLanguage);

  useEffect(() => {
    document.documentElement.setAttribute('lang', language === 'zh-TW' ? 'zh-Hant' : 'en');
    localStorage.setItem('language', language);
  }, [language]);

  const setLanguage = useCallback((lang: Language) => {
    setLanguageState(lang);
  }, []);

  const t = useCallback((key: string, params?: Record<string, string | number>): string => {
    let value = translations[language][key] ?? key;
    if (params) {
      for (const [paramKey, paramValue] of Object.entries(params)) {
        value = value.replace(new RegExp(`\\{${paramKey}\\}`, 'g'), String(paramValue));
      }
    }
    return value;
  }, [language]);

  return (
    <LanguageContext.Provider value={{ language, setLanguage, t }}>
      {children}
    </LanguageContext.Provider>
  );
}

export function useTranslation() {
  const ctx = useContext(LanguageContext);
  if (!ctx) throw new Error('useTranslation must be used within LanguageProvider');
  return ctx;
}
