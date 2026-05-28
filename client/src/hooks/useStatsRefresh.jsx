/**
 * StatsRefresh context — lets any component trigger a Dashboard stats reload.
 *
 * Usage:
 *   // Any component that wants to trigger a refresh:
 *   const { triggerStatsRefresh } = useStatsRefresh();
 *   triggerStatsRefresh();   // call after reprocess / save / retry completes
 *
 *   // DashboardTab listens:
 *   const { statsRefreshKey } = useStatsRefresh();
 *   useEffect(() => { fetchStats(); }, [statsRefreshKey]);
 */
import { createContext, useContext, useState, useCallback } from 'react';

const StatsRefreshContext = createContext({ statsRefreshKey: 0, triggerStatsRefresh: () => {} });

export function StatsRefreshProvider({ children }) {
  const [statsRefreshKey, setStatsRefreshKey] = useState(0);

  const triggerStatsRefresh = useCallback(() => {
    setStatsRefreshKey(k => k + 1);
  }, []);

  return (
    <StatsRefreshContext.Provider value={{ statsRefreshKey, triggerStatsRefresh }}>
      {children}
    </StatsRefreshContext.Provider>
  );
}

// eslint-disable-next-line react-refresh/only-export-components
export function useStatsRefresh() {
  return useContext(StatsRefreshContext);
}
