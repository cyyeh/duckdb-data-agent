import { useEffect, useRef, type ReactNode } from 'react';
import { SessionContext } from '../hooks/useSessionId';

export function SessionProvider({ children }: { children: ReactNode }) {
  const sessionIdRef = useRef<string>(crypto.randomUUID());

  useEffect(() => {
    const sessionId = sessionIdRef.current;

    const interval = setInterval(() => {
      fetch('/api/heartbeat', {
        method: 'POST',
        headers: { 'X-Session-ID': sessionId },
        keepalive: true,
      }).catch(() => {});
    }, 30_000);

    const handleBeforeUnload = (e: BeforeUnloadEvent) => {
      navigator.sendBeacon(`/api/session/cleanup?session_id=${sessionId}`);
      e.preventDefault();
      e.returnValue = '';
    };

    window.addEventListener('beforeunload', handleBeforeUnload);

    return () => {
      clearInterval(interval);
      window.removeEventListener('beforeunload', handleBeforeUnload);
    };
  }, []);

  return (
    <SessionContext.Provider value={sessionIdRef.current}>
      {children}
    </SessionContext.Provider>
  );
}
