import { useEffect, useState } from 'react';
import type { AppState, ModelCatalog } from '../types';
import { api } from '../lib/api';
import { buildDefaultState, MODEL_CATALOG_TTL_MS, normalizeStoredState } from '../lib/data';
import { loadModelCatalogCache, loadState, saveModelCatalogCache, saveState } from '../lib/idb';
import { isCacheFresh } from '../lib/modelCatalog';
import type { StudioAction } from '../state/studioReducer';
import type { UiAction } from '../state/uiReducer';

export function useStudioBootstrap({
  state,
  hydrated,
  dispatchStudio,
  dispatchUi
}: {
  state: AppState;
  hydrated: boolean;
  dispatchStudio: React.Dispatch<StudioAction>;
  dispatchUi: React.Dispatch<UiAction>;
}) {
  const [modelCatalog, setModelCatalog] = useState<ModelCatalog | null>(null);

  useEffect(() => {
    let cancelled = false;
    let hasUsableCatalog = false;

    async function refreshCatalog(hasCache: boolean) {
      try {
        const response = await api.models();
        if (cancelled) return;
        const catalog = { provider: response.provider, updated: response.updated, sourceDocs: response.sourceDocs, notes: response.notes, models: response.models } satisfies ModelCatalog;
        const cache = { catalog, cachedAt: new Date().toISOString() };
        hasUsableCatalog = catalog.models.length > 0;
        setModelCatalog(catalog);
        dispatchStudio({ type: 'normalize-for-catalog', catalog });
        dispatchUi({ type: 'api-status', apiStatus: `Model catalog updated · ${response.count} models` });
        void saveModelCatalogCache(cache).catch(() => dispatchUi({ type: 'api-status', apiStatus: 'Model catalog loaded; cache write failed' }));
      } catch (error) {
        if (cancelled) return;
        const message = error instanceof Error ? error.message : 'unknown error';
        dispatchUi({ type: 'api-status', apiStatus: hasCache ? `Using cached model catalog; refresh failed (${message})` : `Model catalog unavailable; generation disabled (${message})` });
      }
    }

    Promise.all([loadState(), loadModelCatalogCache()]).then(([stored, cached]) => {
      if (cancelled) return;
      const restored = stored?.version === 1 ? normalizeStoredState(stored) : buildDefaultState();
      const cacheUsable = Boolean(cached?.catalog?.models?.length);
      if (cacheUsable && cached) {
        hasUsableCatalog = true;
        setModelCatalog(cached.catalog);
        dispatchStudio({ type: 'hydrate', state: restored });
        dispatchStudio({ type: 'normalize-for-catalog', catalog: cached.catalog });
        dispatchUi({ type: 'hydrate', apiStatus: isCacheFresh(cached) ? `Model catalog loaded from cache · ${cached.catalog.models.length}; refreshing…` : 'Using cached model catalog; refreshing…' });
        void refreshCatalog(true);
      } else {
        dispatchStudio({ type: 'hydrate', state: restored });
        dispatchUi({ type: 'hydrate', apiStatus: 'Loading model catalog…' });
        void refreshCatalog(false);
      }
    }).catch(() => {
      if (cancelled) return;
      dispatchUi({ type: 'hydrate', apiStatus: 'IndexedDB unavailable; loading model catalog…' });
      void refreshCatalog(false);
    });

    const refreshInterval = window.setInterval(() => { void refreshCatalog(hasUsableCatalog); }, MODEL_CATALOG_TTL_MS);

    return () => {
      cancelled = true;
      window.clearInterval(refreshInterval);
    };
  }, [dispatchStudio, dispatchUi]);

  useEffect(() => {
    if (!hydrated) return;
    const id = window.setTimeout(() => { void saveState(state); }, 180);
    return () => window.clearTimeout(id);
  }, [state, hydrated]);

  return modelCatalog;
}
