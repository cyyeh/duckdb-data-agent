import { createContext, useContext } from 'react';

export type ChartLibrary = 'plotly' | 'vegalite';

interface ChartLibraryContextValue {
  chartLibrary: ChartLibrary;
  setChartLibrary: (lib: ChartLibrary) => void;
}

export const ChartLibraryContext = createContext<ChartLibraryContextValue>({
  chartLibrary: 'plotly',
  setChartLibrary: () => {},
});

export function useChartLibrary() {
  return useContext(ChartLibraryContext);
}
