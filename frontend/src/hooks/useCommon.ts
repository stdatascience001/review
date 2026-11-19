import { useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { projectsApi, websitesApi } from '@/api/resources';

export const useDebounce = <T,>(value: T, delay = 300): T => {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(value), delay);
    return () => clearTimeout(t);
  }, [value, delay]);
  return debounced;
};

/** All websites the user can access (for selects and filters). */
export const useWebsiteOptions = () =>
  useQuery({
    queryKey: ['websites', 'options'],
    queryFn: () => websitesApi.list({ pageSize: 100 }),
    select: (d) => d.items,
    staleTime: 60_000,
  });

/** Projects the user can access, optionally within one website. */
export const useProjectOptions = (websiteId?: string) =>
  useQuery({
    queryKey: ['projects', 'options', websiteId ?? 'all'],
    queryFn: () => projectsApi.list({ pageSize: 200, websiteId }),
    select: (d) => d.items,
    staleTime: 60_000,
  });

/** Reset to page 1 whenever any filter changes. */
export const usePagedFilters = <T extends object>(initial: T) => {
  const [filters, setFilters] = useState(initial);
  const [page, setPage] = useState(1);
  const update = (patch: Partial<T>) => {
    setFilters((f) => ({ ...f, ...patch }));
    setPage(1);
  };
  return { filters, update, page, setPage };
};
