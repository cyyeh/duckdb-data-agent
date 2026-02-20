import { useContext } from 'react';
import { SessionContext } from '../contexts/SessionContext';

export function useSessionId(): string {
  return useContext(SessionContext);
}
