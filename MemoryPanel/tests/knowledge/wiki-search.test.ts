import { afterEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { registerKnowledgeWikiRoutes } from '../../src/panel/http/routes/knowledge/wiki-routes.js';
import { HttpKnowledgeClient } from '../../src/panel/kernel/adapters/http-knowledge-client.js';
import type { PanelDeps } from '../../src/panel/panel-deps.js';

afterEach(() => vi.unstubAllGlobals());

function setup(allowed = true) {
  const response = { results: [{ path: 'b.md', title: 'B', score: 0.5, type: 'entity', snippet: '', hop: 1, via: 'A' }],
    links: [{ source: 'a.md', target: 'b.md', weight: 1 }], count: 1 };
  const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ code: 0, data: response })));
  vi.stubGlobal('fetch', fetchMock);
  const invoke = vi.fn(async (action: string) => {
    const data: Record<string, unknown> = {
      'auth/verify': { valid: true, user: { user_id: 'user' } },
      'asset/get': { team_id: 'team' }, 'acl/check': { allowed }, 'team-member/get': { user_id: 'user' },
    };
    return { code: 0, data: data[action] };
  });
  const app = new Hono();
  registerKnowledgeWikiRoutes(app, {
    instanceRegistry: { resolve: () => ({ instance_id: 'instance', gateway_endpoint: 'http://core', api_key: '' }) },
    metaKernel: { invoke },
    knowledgeClientFactory: () => new HttpKnowledgeClient({ baseUrl: 'http://knowledge', authToken: 'test', serviceId: 'instance' }),
  } as unknown as PanelDeps);
  const request = (params: Record<string, unknown>) => app.request('/knowledge/wiki/search', {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Tdai-Service-Id': 'instance', 'X-Tdai-User-Key': 'test' },
    body: JSON.stringify({ wiki_id: 'wiki', query: 'keyword', ...params }),
  });
  return { request, fetchMock, response };
}

describe('Panel Wiki search route through HTTP adapter', () => {
  it('forwards top-level graph fields and preserves result provenance', async () => {
    const { request, fetchMock, response } = setup();
    const res = await request({ hop: 2, decay: 0.5, minScore: 0 });
    expect(res.status).toBe(200);
    expect((await res.json()).data).toEqual(response);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('http://knowledge/v3/wiki/search');
    expect(JSON.parse(init.body)).toEqual({ wiki_id: 'wiki', query: 'keyword', limit: 20, hop: 2, decay: 0.5, minScore: 0 });
  });

  it.each([{}, { hop: 0 }, { hop: 5, decay: 0, minScore: 0 }, { hop: 1, decay: 1, minScore: 100 }])('accepts compatible/boundary request %j', async (options) => {
    const { request, fetchMock } = setup();
    expect((await request(options)).status).toBe(200);
    expect(JSON.parse(fetchMock.mock.calls[0]![1].body)).toEqual({ wiki_id: 'wiki', query: 'keyword', limit: 20, ...options });
  });

  it.each([{ hop: -1 }, { hop: 6 }, { hop: 1.5 }, { hop: '1' }, { hop: null },
    { decay: -0.1 }, { decay: 1.1 }, { decay: '0.5' }, { minScore: -1 }, { minScore: null }])('rejects invalid parameters %j', async (options) => {
    const { request, fetchMock } = setup();
    expect((await request(options)).status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('keeps the existing access check before the Knowledge request', async () => {
    const { request, fetchMock } = setup(false);
    expect((await request({ hop: 2 })).status).toBe(403);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
