import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { createDb } from "../src/db/client.js";
import { SqliteKnowledgeStore } from "../src/store/sqlite-store.js";
import { WikiService } from "../src/store/wiki-service.js";
import { BuildQueue } from "../src/store/build-queue.js";
import { createWikiSourceManager } from "../src/engines/wiki/manager.js";
import { evictWikiDb, getReadDb, hasPublishedSnapshot, withWriteDb } from "../src/engines/wiki/index-db.js";
import { createWikiRoutes } from "../src/routes/wiki.js";
import { createToolsRoutes } from "../src/routes/tools.js";
import { accessLog } from "../src/middleware/response-envelope.js";

// Keep real database, orchestration and HTTP routes; replace only the external LLM work.
const llm = vi.hoisted(() => ({ extract: vi.fn(), commit: vi.fn() }));
vi.mock("../src/engines/wiki/ingest-v2/index.js", () => ({
  extractSource: llm.extract,
  commitCandidates: llm.commit,
  scanExistingPages: () => [],
}));
vi.mock("../src/engines/wiki/ingest-v2/llm.js", () => ({ createLlmClient: () => ({}) }));
vi.mock("../src/engines/wiki/ingest-v2/overview.js", () => ({ generateOverview: async () => {} }));
vi.mock("../src/engines/code/index.js", () => ({ executeTool: vi.fn() }));

const serviceId = "test-service";
const teamId = "test-team";
const original = "---\ntitle: Redis\ntype: entity\ndescription: Published description\nlocked: true\n---\n# Redis\noldtoken [[Cache]]";
const updated = "---\ntitle: Redis updated\ntype: entity\n---\n# Redis updated\nnewtoken";
let root: string;
let dir: string;
let wikiId: string;
let engineDir: string;
let store: SqliteKnowledgeStore;
let service: WikiService;
let mgr: ReturnType<typeof createWikiSourceManager>;
let database: ReturnType<typeof createDb>;
let queue: BuildQueue;
let app: Hono;

function post(path: string, body: Record<string, unknown>, tenant = serviceId) {
  return app.request(path, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-tdai-service-id": tenant },
    body: JSON.stringify(body),
  });
}

function wiki(path: string, body = {}) { return post(`/wiki/${path}`, { wiki_id: wikiId, ...body }); }
function tool(name: string, params = {}) {
  return post("/tools/call", { knowledge_id: wikiId, tool_name: name, params });
}

beforeEach(() => {
  llm.extract.mockReset().mockResolvedValue(new Map([["wiki/entities/redis.md", updated]]));
  llm.commit.mockReset().mockResolvedValue({ written: [], mergeErrors: [] });
  root = mkdtempSync(join(tmpdir(), "wiki-published-test-"));
  database = createDb({ path: ":memory:" });
  store = new SqliteKnowledgeStore(database.db);
  queue = new BuildQueue();
  engineDir = join(root, "engines");
  mgr = createWikiSourceManager(engineDir);
  service = new WikiService({ store, dataRoot: root, queue, worker: async (ctx) => {
    await mgr.ingest(ctx.wikiId, {});
    return { pageCount: mgr.getPages(ctx.wikiId).length };
  } });
  wikiId = service.create({ service_id: serviceId, team_id: teamId, name: "Fixture" }).row.wiki_id;
  dir = service.dirFor(serviceId, teamId, wikiId);
  mkdirSync(join(dir, "wiki/entities"), { recursive: true });
  writeFileSync(join(dir, "wiki/entities/redis.md"), original);
  writeFileSync(join(dir, "wiki/entities/cache.md"), "---\ntitle: Cache\ntype: entity\n---\nCache");
  mgr.register({ name: wikiId, path: dir });
  store.updateWikiStatus(serviceId, wikiId, { status: "ready", page_count: 2 });
  app = new Hono();
  app.use("*", accessLog());
  app.route("/wiki", createWikiRoutes({ wikiService: service, wikiMgr: mgr, publicBaseUrl: "http://test/v3" }));
  app.route("/tools", createToolsRoutes({ wikiService: service, wikiMgr: mgr, cgService: {} as never, instancePool: {} as never }));
});

afterEach(async () => {
  await queue.onIdle();
  evictWikiDb(wikiId);
  database.raw.close();
  rmSync(root, { recursive: true, force: true });
});

describe.each(["pending", "processing", "failed", "ready"] as const)("published reads while %s", (status) => {
  it("keeps search, graph, list and body available through HTTP and Agent tools", async () => {
    store.updateWikiStatus(serviceId, wikiId, { status });
    // Simulate an unfinished merge and cascade deletion on disk.
    writeFileSync(join(dir, "wiki/entities/redis.md"), updated);
    rmSync(join(dir, "wiki/entities/cache.md"));
    writeFileSync(join(dir, "wiki/entities/unpublished.md"), "unpublishedtoken");
    for (const response of [await wiki("search", { query: "oldtoken" }), await tool("search", { query: "oldtoken" })]) {
      expect(response.status).toBe(200);
      const { data } = await response.json();
      expect(data.results[0]).toMatchObject({ title: "Redis", snippet: "Published description" });
    }
    expect((await (await wiki("search", { query: "newtoken" })).json()).data.count).toBe(0);
    for (const response of [await wiki("page/ls"), await tool("list_pages")]) {
      const { data } = await response.json();
      expect(data.items).toHaveLength(2);
      expect(data.items.find((p: { id: string }) => p.id === "entities/redis")).toMatchObject({ locked: true, description: "Published description" });
    }
    for (const response of [await wiki("page/read", { refs: ["entities/redis", "wiki/entities/cache.md", "entities/unpublished"] }),
      await tool("read_page", { refs: ["entities/redis", "wiki/entities/cache.md", "entities/unpublished"] })]) {
      const { data } = await response.json();
      expect(data.items[0].content).toBe(original);
      expect(data.items[1].content).toContain("Cache");
      expect(data.items[2].not_found).toBe(true);
    }
    for (const response of [await wiki("graph"), await tool("get_graph")]) {
      const { data } = await response.json();
      expect(data.nodes).toHaveLength(2);
      expect(data.edges).toHaveLength(1);
    }
    expect(mgr.readPage(wikiId, "wiki/entities/redis.md")).toBe(original);
    expect(service.pageRead(serviceId, teamId, wikiId, "entities/cache")).toContain("Cache");
  });
});

it("keeps first ingestion empty until a content snapshot is published", async () => {
  const row = service.create({ service_id: serviceId, team_id: teamId, name: "Empty" }).row;
  const emptyDir = service.dirFor(serviceId, teamId, row.wiki_id);
  try {
    mgr.init({ name: row.wiki_id, path: emptyDir });
    store.updateWikiStatus(serviceId, row.wiki_id, { status: "processing" });
    expect(service.pageLs(serviceId, teamId, row.wiki_id)).toEqual([]);
    expect(mgr.graph(row.wiki_id).nodes).toEqual([]);
    expect(mgr.search(row.wiki_id, "Wiki").count).toBe(0);
    expect(mgr.readPage(row.wiki_id, "schema")).toBeNull();
  } finally { evictWikiDb(row.wiki_id); }
});

it("serves the old snapshot throughout real queued ingestion, then publishes the new batch", async () => {
  writeFileSync(join(dir, "raw/sources/doc.md"), "source");
  let release!: () => void;
  let reached!: () => void;
  const merging = new Promise<void>((resolve) => { reached = resolve; });
  const gate = new Promise<void>((resolve) => { release = resolve; });
  llm.commit.mockImplementation(async () => {
    writeFileSync(join(dir, "wiki/entities/redis.md"), updated);
    reached();
    await gate;
    return { written: ["wiki/entities/redis.md"], mergeErrors: [] };
  });
  expect(service.ingest(serviceId, teamId, wikiId).kind).toBe("ok");
  await merging;
  try {
    expect(store.getWikiById(serviceId, wikiId)?.status).toBe("processing");
    expect(service.ingest(serviceId, teamId, wikiId).kind).toBe("busy");
    expect(service.pageWrite(serviceId, teamId, wikiId, "entities/redis", "edit")).toBe("processing");
    expect((await (await wiki("search", { query: "oldtoken" })).json()).data.count).toBe(1);
    expect((await (await tool("read_page", { refs: ["entities/redis"] })).json()).data.items[0].content).toBe(original);
  } finally { release(); }
  await queue.onIdle();
  expect(store.getWikiById(serviceId, wikiId)?.status).toBe("ready");
  expect(mgr.search(wikiId, "newtoken").count).toBe(1);
  expect(mgr.search(wikiId, "oldtoken").count).toBe(0);
  expect(service.pageRead(serviceId, teamId, wikiId, "entities/redis")).toBe(updated);
  expect(service.pageLs(serviceId, teamId, wikiId)?.find((p) => p.id === "entities/redis")?.locked).toBe(false);
});

it("preserves the publication after all sources fail, including after restart", async () => {
  writeFileSync(join(dir, "raw/sources/doc.md"), "source");
  writeFileSync(join(dir, "wiki/entities/redis.md"), updated);
  llm.extract.mockRejectedValue(new Error("LLM unavailable"));
  service.ingest(serviceId, teamId, wikiId);
  await queue.onIdle();
  expect(store.getWikiById(serviceId, wikiId)?.status).toBe("failed");
  expect(getReadDb(wikiId, dir).prepare("SELECT status FROM source").get()).toEqual({ status: "failed" });
  evictWikiDb(wikiId);
  mgr = createWikiSourceManager(engineDir);
  expect(mgr.search(wikiId, "oldtoken").count).toBe(1);
  expect(mgr.readPage(wikiId, "entities/redis")).toBe(original);
});

it("does not rebuild a committed index from unfinished files on restart", () => {
  writeFileSync(join(dir, "wiki/entities/redis.md"), updated);
  const statePath = join(engineDir, "wiki-sources.json");
  const states = JSON.parse(readFileSync(statePath, "utf8"));
  states[wikiId].status = "scanning";
  writeFileSync(statePath, JSON.stringify(states));
  evictWikiDb(wikiId);
  mgr = createWikiSourceManager(engineDir);
  expect(mgr.get(wikiId)?.status).toBe("error");
  expect(mgr.search(wikiId, "oldtoken").count).toBe(1);
  expect(mgr.readPage(wikiId, "entities/redis")).toBe(original);
});

it("migrates a legacy ready index once and preserves the new snapshot thereafter", () => {
  withWriteDb(dir, (db) => db.exec("DROP TABLE page_content; DROP TABLE wiki_publication;"));
  evictWikiDb(wikiId);
  mgr = createWikiSourceManager(engineDir);
  expect(hasPublishedSnapshot(getReadDb(wikiId, dir))).toBe(true);
  expect(mgr.readPage(wikiId, "entities/redis")).toBe(original);
  writeFileSync(join(dir, "wiki/entities/redis.md"), updated);
  evictWikiDb(wikiId);
  mgr = createWikiSourceManager(engineDir);
  expect(mgr.readPage(wikiId, "entities/redis")).toBe(original);
});

it("rolls back the body and index together when publication fails", () => {
  withWriteDb(dir, (db) => db.exec(`CREATE TRIGGER reject_publication BEFORE UPDATE ON wiki_publication
    BEGIN SELECT RAISE(ABORT, 'test publication failure'); END;`));
  writeFileSync(join(dir, "wiki/entities/redis.md"), updated);
  expect(mgr.sync(wikiId).status).toBe("error");
  expect(mgr.search(wikiId, "oldtoken").count).toBe(1);
  expect(mgr.search(wikiId, "newtoken").count).toBe(0);
  expect(mgr.readPage(wikiId, "entities/redis")).toBe(original);
});

it("does not include unindexed working files when upgrading a legacy index", () => {
  withWriteDb(dir, (db) => db.exec("DROP TABLE page_content; DROP TABLE wiki_publication;"));
  writeFileSync(join(dir, "wiki/entities/unpublished.md"), "unpublishedtoken");
  evictWikiDb(wikiId);
  mgr = createWikiSourceManager(engineDir);
  expect(mgr.search(wikiId, "unpublishedtoken").count).toBe(0);
  expect(service.pageLs(serviceId, teamId, wikiId)).toHaveLength(2);
  expect(mgr.readPage(wikiId, "entities/unpublished")).toBeNull();
});

it("never upgrades an interrupted legacy merge into a published result", () => {
  withWriteDb(dir, (db) => db.exec("DROP TABLE page_content; DROP TABLE wiki_publication;"));
  writeFileSync(join(dir, "wiki/entities/redis.md"), updated);
  evictWikiDb(wikiId);
  mgr = createWikiSourceManager(engineDir);
  expect(mgr.get(wikiId)?.status).toBe("error");
  expect(hasPublishedSnapshot(getReadDb(wikiId, dir))).toBe(false);
  expect(mgr.search(wikiId, "oldtoken").count).toBe(1);
  expect(mgr.search(wikiId, "newtoken").count).toBe(0);
  expect(mgr.readPage(wikiId, "entities/redis")).toBeNull();
});

it("publishes manual page edits through the existing write route", async () => {
  const response = await wiki("page/write", { team_id: teamId, pages: [{ ref: "entities/redis", content: updated }] });
  expect(response.status).toBe(200);
  expect(service.pageRead(serviceId, teamId, wikiId, "entities/redis")).toContain("newtoken");
  expect(mgr.search(wikiId, "newtoken").count).toBe(1);
  expect(service.pageLs(serviceId, teamId, wikiId)?.find((p) => p.id === "entities/redis")?.locked).toBe(true);
});

it("preserves tenant isolation, input validation and deletion behavior", async () => {
  store.updateWikiStatus(serviceId, wikiId, { status: "processing" });
  for (const path of ["search", "graph", "page/ls", "page/read"]) {
    expect((await post(`/wiki/${path}`, { wiki_id: wikiId, query: "oldtoken", refs: ["entities/redis"] }, "foreign-service")).status).toBe(404);
  }
  expect((await post("/tools/call", { knowledge_id: wikiId, tool_name: "search", params: { query: "oldtoken" } }, "foreign-service")).status).toBe(404);
  expect(service.pageLs(serviceId, "foreign-team", wikiId)).toBeNull();
  expect((await wiki("page/read", { refs: ["../secret"] })).status).toBe(400);
  expect((await tool("read_page", { refs: ["../secret"] })).status).toBe(400);
  expect((await wiki("search", { query: "oldtoken", hop: -1 })).status).toBe(400);
  store.updateWikiStatus(serviceId, wikiId, { status: "ready" });
  service.delete(serviceId, teamId, wikiId);
  expect((await wiki("page/ls")).status).toBe(404);
});
