import { useState, useCallback, type ReactNode } from 'react';
import { ChartLibraryContext, type ChartLibrary } from '../hooks/useChartLibrary';

function getInitialLibrary(): ChartLibrary {
  const stored = localStorage.getItem('chartLibrary');
  if (stored === 'plotly' || stored === 'vegalite') return stored;
  return 'plotly';
}

export function ChartLibraryProvider({ children }: { children: ReactNode }) {
  const [chartLibrary, setChartLibraryState] = useState<ChartLibrary>(getInitialLibrary);

  const setChartLibrary = useCallback((lib: ChartLibrary) => {
    setChartLibraryState(lib);
    localStorage.setItem('chartLibrary', lib);
  }, []);

  return (
    <ChartLibraryContext.Provider value={{ chartLibrary, setChartLibrary }}>
      {children}
    </ChartLibraryContext.Provider>
  );
}
