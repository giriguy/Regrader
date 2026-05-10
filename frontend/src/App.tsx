import { useCallback, useEffect, useState } from 'react';
import { api } from './api';
import { Connect } from './pages/Connect';
import { Browse } from './pages/Browse';

type View = 'loading' | 'connect' | 'browse';

export default function App() {
  const [view, setView] = useState<View>('loading');

  const checkStatus = useCallback(async () => {
    try {
      const status = await api.status();
      setView(status.connected ? 'browse' : 'connect');
    } catch {
      setView('connect');
    }
  }, []);

  useEffect(() => {
    checkStatus();
  }, [checkStatus]);

  if (view === 'loading') {
    return (
      <div className="flex min-h-screen items-center justify-center text-sm text-slate-500">
        Loading…
      </div>
    );
  }

  if (view === 'connect') {
    return <Connect onConnected={() => setView('browse')} />;
  }

  return <Browse onDisconnected={() => setView('connect')} />;
}
