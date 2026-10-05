import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { knowledgeApi, type WikiSearchOptions, type WikiSearchResponse } from '@/lib/api/knowledge-api';
import { tea } from '@/lib/tea-bridge';

export interface GraphSearchSettings {
  enabled: boolean;
  hop: number;
  decay: number;
  minScore: number;
}

export const DEFAULT_GRAPH_SETTINGS: GraphSearchSettings = { enabled: false, hop: 1, decay: 0.5, minScore: 0.1 };

export function validGraphSettings(value: GraphSearchSettings): boolean {
  return typeof value.enabled === 'boolean'
    && Number.isInteger(value.hop) && value.hop >= 1 && value.hop <= 5
    && Number.isFinite(value.decay) && value.decay >= 0 && value.decay <= 1
    && Number.isFinite(value.minScore) && value.minScore >= 0;
}

function readSettings(key: string): GraphSearchSettings {
  try {
    const value = JSON.parse(localStorage.getItem(key) ?? 'null');
    if (value && validGraphSettings(value)) return value;
  } catch { /* Storage is optional; invalid preferences fall back to defaults. */ }
  return { ...DEFAULT_GRAPH_SETTINGS };
}

export function useWikiSearch(wikiId: string, instanceId: string, userId: string, active: boolean) {
  const { t } = useTranslation();
  const key = `tdai-panel.wiki-search.v1:${JSON.stringify([instanceId, userId, wikiId])}`;
  const restored = useMemo(() => readSettings(key), [key]);
  const [draft, setDraft] = useState({ key, settings: restored });
  const graphSettings = draft.key === key ? draft.settings : restored;
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<WikiSearchResponse['results']>([]);
  const [searching, setSearching] = useState(false);
  const [lastSearch, setLastSearch] = useState<{ query: string; options: WikiSearchOptions } | null>(null);
  const requestSeq = useRef(0);
  const scope = `${key}:${active}`;
  const scopeRef = useRef(scope);
  scopeRef.current = scope;

  const resetSearch = useCallback(() => {
    requestSeq.current++;
    setSearchQuery('');
    setSearchResults([]);
    setLastSearch(null);
    setSearching(false);
  }, []);

  useEffect(() => {
    resetSearch();
    return () => { requestSeq.current++; };
  }, [scope, resetSearch]);

  const setGraphSettings = (settings: GraphSearchSettings) => {
    setDraft({ key, settings });
    // Keep incomplete numeric inputs in memory; never persist invalid settings.
    if (wikiId && instanceId && userId && validGraphSettings(settings)) {
      try { localStorage.setItem(key, JSON.stringify(settings)); } catch { /* Optional preference storage. */ }
    }
  };

  const options: WikiSearchOptions = graphSettings.enabled
    ? { hop: graphSettings.hop, decay: graphSettings.decay, minScore: graphSettings.minScore }
    : { hop: 0 };
  const searchSettingsValid = !graphSettings.enabled || validGraphSettings(graphSettings);
  const searchDirty = !!lastSearch && (lastSearch.query !== searchQuery.trim()
    || JSON.stringify(lastSearch.options) !== JSON.stringify(options));

  const handleSearch = async () => {
    const query = searchQuery.trim();
    if (!query || !wikiId || !active) return;
    if (!searchSettingsValid) { tea.notify.error(t('wiki.detail.search.invalid')); return; }
    const seq = ++requestSeq.current;
    const current = () => seq === requestSeq.current && scopeRef.current === scope;
    setSearching(true);
    setSearchResults([]);
    setLastSearch(null);
    try {
      const response = await knowledgeApi.wiki.search(wikiId, query, 20, options);
      if (!current()) return;
      setSearchResults(response.results ?? []);
      setLastSearch({ query, options });
    } catch (error: unknown) {
      if (current()) tea.notify.error(error);
    } finally {
      if (current()) setSearching(false);
    }
  };

  return { searchQuery, setSearchQuery, searchResults, searching, handleSearch, resetSearch,
    graphSettings, setGraphSettings, resetGraphSettings: () => setGraphSettings({ ...DEFAULT_GRAPH_SETTINGS }),
    searchSettingsValid, searchDirty, lastSearch };
}
