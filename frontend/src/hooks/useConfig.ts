import { createContext, useContext } from 'react';

interface ConfigContextValue {
  maxTotalSizeBytes: number;
}

export const DEFAULT_MAX_TOTAL_SIZE_BYTES = 500 * 1024 * 1024; // 500MB

export const ConfigContext = createContext<ConfigContextValue>({
  maxTotalSizeBytes: DEFAULT_MAX_TOTAL_SIZE_BYTES,
});

export function useConfig() {
  return useContext(ConfigContext);
}
