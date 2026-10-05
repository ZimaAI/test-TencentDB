import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useWikiSearch, DEFAULT_GRAPH_SETTINGS } from '../src/pages/WikiPage/hooks/useWikiSearch';
import type { WikiSearchResponse } from '../src/lib/api/knowledge-api';

const { search, notify } = vi.hoisted(() => ({ search: vi.fn(), notify: vi.fn() }));
vi.mock('@/lib/api/knowledge-api', () => ({ knowledgeApi: { wiki: { search } } }));
vi.mock('@/lib/tea-bridge', () => ({ tea: { notify: { error: notify } } }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
const empty: WikiSearchResponse = { results: [], links: [], count: 0 };
beforeEach(() => { localStorage.clear(); search.mockReset().mockResolvedValue(empty); notify.mockReset(); });
afterEach(cleanup);

it('defaults to BM25, sends graph options when enabled, and flags changed settings', async () => {
  const { result } = renderHook(() => useWikiSearch('wiki', 'instance', 'user', true));
  act(() => result.current.setSearchQuery(' keyword '));
  await act(() => result.current.handleSearch());
  expect(search).toHaveBeenLastCalledWith('wiki', 'keyword', 20, { hop: 0 });
  act(() => result.current.setGraphSettings({ enabled: true, hop: 2, decay: 0.7, minScore: 0 }));
  expect(result.current.searchDirty).toBe(true);
  await act(() => result.current.handleSearch());
  expect(search).toHaveBeenLastCalledWith('wiki', 'keyword', 20, { hop: 2, decay: 0.7, minScore: 0 });
  expect(result.current.searchDirty).toBe(false);
  act(() => result.current.setGraphSettings({ ...result.current.graphSettings, enabled: false }));
  await act(() => result.current.handleSearch());
  expect(search).toHaveBeenLastCalledWith('wiki', 'keyword', 20, { hop: 0 });
  expect(result.current.graphSettings.hop).toBe(2);
});

it('restores preferences and isolates Wiki, user and instance scopes', () => {
  const settings = { enabled: true, hop: 3, decay: 0.6, minScore: 0 };
  const { result, rerender, unmount } = renderHook(({ wiki, instance, user }) => useWikiSearch(wiki, instance, user, true),
    { initialProps: { wiki: 'a', instance: 'one', user: 'alice' } });
  act(() => result.current.setGraphSettings(settings));
  for (const props of [{ wiki: 'b', instance: 'one', user: 'alice' }, { wiki: 'a', instance: 'two', user: 'alice' }, { wiki: 'a', instance: 'one', user: 'bob' }]) {
    rerender(props);
    expect(result.current.graphSettings).toEqual(DEFAULT_GRAPH_SETTINGS);
  }
  unmount();
  const restored = renderHook(() => useWikiSearch('a', 'one', 'alice', true));
  expect(restored.result.current.graphSettings).toEqual(settings);
  act(() => restored.result.current.resetGraphSettings());
  expect(restored.result.current.graphSettings).toEqual(DEFAULT_GRAPH_SETTINGS);
});

it('blocks invalid inputs without persisting them and tolerates broken storage', async () => {
  localStorage.setItem('tdai-panel.wiki-search.v1:["instance","user","wiki"]', '{broken');
  const { result } = renderHook(() => useWikiSearch('wiki', 'instance', 'user', true));
  expect(result.current.graphSettings).toEqual(DEFAULT_GRAPH_SETTINGS);
  act(() => { result.current.setSearchQuery('test'); result.current.setGraphSettings({ enabled: true, hop: 1.5, decay: NaN, minScore: -1 }); });
  await act(() => result.current.handleSearch());
  expect(search).not.toHaveBeenCalled();
  expect(result.current.searchSettingsValid).toBe(false);
  expect(notify).toHaveBeenCalled();
});

it('ignores late successes and errors from superseded requests or another Wiki', async () => {
  let resolveFirst!: (response: WikiSearchResponse) => void;
  let rejectOld!: (error: Error) => void;
  search.mockImplementationOnce(() => new Promise((resolve) => { resolveFirst = resolve; }));
  const { result, rerender } = renderHook(({ wiki }) => useWikiSearch(wiki, 'instance', 'user', true), { initialProps: { wiki: 'a' } });
  act(() => result.current.setSearchQuery('first'));
  let first!: Promise<void>;
  act(() => { first = result.current.handleSearch(); });
  act(() => result.current.setSearchQuery('second'));
  await act(() => result.current.handleSearch());
  await act(async () => { resolveFirst(empty); await first; });
  expect(result.current.lastSearch?.query).toBe('second');
  search.mockImplementationOnce(() => new Promise((_, reject) => { rejectOld = reject; }));
  let old!: Promise<void>;
  act(() => { old = result.current.handleSearch(); });
  rerender({ wiki: 'b' });
  await act(async () => { rejectOld(new Error('old error')); await old; });
  expect(notify).not.toHaveBeenCalled();
  expect(result.current.lastSearch).toBeNull();
  expect(result.current.searching).toBe(false);
});
