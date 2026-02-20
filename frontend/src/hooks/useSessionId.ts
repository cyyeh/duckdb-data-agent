import { createContext, useContext } from 'react';

export const SessionContext = createContext<string>('');

export function useSessionId(): string {
  return useContext(SessionContext);
}
