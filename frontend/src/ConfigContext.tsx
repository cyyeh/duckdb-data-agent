import { createContext, useContext, useState, useEffect, type ReactNode } from 'react';

interface ConfigContextValue {
  maxTotalSizeBytes: number;
}

const DEFAULT_MAX_TOTAL_SIZE_BYTES = 500 * 1024 * 1024; // 500MB

const ConfigContext = createContext<ConfigContextValue>({
  maxTotalSizeBytes: DEFAULT_MAX_TOTAL_SIZE_BYTES,
});

export function ConfigProvider({ children }: { children: ReactNode }) {
  const [maxTotalSizeBytes, setMaxTotalSizeBytes] = useState(DEFAULT_MAX_TOTAL_SIZE_BYTES);

  useEffect(() => {
    (async () => {
      try {
        const res = await fetch('/api/config');
        if (res.ok) {
          const data = await res.json();
          if (typeof data.maxTotalSizeBytes === 'number') {
            setMaxTotalSizeBytes(data.maxTotalSizeBytes);
          }
        }
      } catch {
        // Config fetch is non-critical; use default
      }
    })();
  }, []);

  return (
    <ConfigContext.Provider value={{ maxTotalSizeBytes }}>
      {children}
    </ConfigContext.Provider>
  );
}

export function useConfig() {
  return useContext(ConfigContext);
}
