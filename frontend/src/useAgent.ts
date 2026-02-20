import { useContext } from 'react';
import { AgentContext } from './AgentContext';

export function useAgent() {
  return useContext(AgentContext);
}
