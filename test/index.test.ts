import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// index.ts는 import되는 순간 self.addEventListener("fetch")를 호출한다.
// Node에는 self가 없으므로 import보다 먼저 가짜를 심어 두고, 등록된 리스너를 잡아 둔다.
const { addEventListener } = vi.hoisted(() => {
  const addEventListener = vi.fn();
  (globalThis as any).self = { addEventListener };
  return { addEventListener };
});

import { handleRequest, CacheLike } from "../src/index";

// 테스트마다 mock 기록이 초기화되므로 import 직후 등록된 fetch 리스너를 잡아 둔다.
const fetchListener = addEventListener.mock.calls.find(
  (c) => c[0] === "fetch"
)?.[1];

const WORKER_ORIGIN = "https://worker.example.com";
const PAGE_ID = "11111111-1111-1111-1111-111111111111";

type NotionHandler = (body: any) => Response | Promise<Response>;

// 노션 응답 흉내: URL 마지막 경로(resource)별로 응답을 정한다.
const mockNotion = (handlers: Record<string, NotionHandler>) => {
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    const resource = String(url).split("/").pop()!;
    const handler = handlers[resource];
    if (!handler) {
      throw new Error(`예상하지 못한 노션 호출: ${resource}`);
    }
    return handler(JSON.parse(String(init?.body)));
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
};

const calledResources = (fetchMock: ReturnType<typeof mockNotion>) =>
  fetchMock.mock.calls.map((c) => String(c[0]).split("/").pop());

const notionJson = (data: unknown) =>
  new Response(JSON.stringify(data), {
    status: 200,
    headers: { "content-type": "application/json; charset=utf-8" },
  });

const rateLimited = (retryAfter?: string) =>
  new Response("error code: 1015\n", {
    status: 429,
    headers: {
      "content-type": "text/plain; charset=UTF-8",
      ...(retryAfter ? { "retry-after": retryAfter } : {}),
    },
  });

// 노션의 현재 레코드 형식: { value: { value: <block>, role } }
const doubleNested = (block: Record<string, unknown>) => ({
  value: { value: block, role: "reader" },
});

const createCache = (cached?: Response) => {
  const cache = {
    match: vi.fn(async () => cached),
    put: vi.fn(async () => undefined),
  };
  return cache satisfies CacheLike;
};

const createContext = (cache: CacheLike) => {
  const pending: Promise<unknown>[] = [];
  return {
    pending,
    context: {
      cache,
      waitUntil: (p: Promise<unknown>) => {
        pending.push(p);
      },
    },
  };
};

// 운영의 Spring API 서버처럼 Cache-Control: no-cache로 호출한다(캐시 키 없음).
const pageRequest = (noCache = true) =>
  new Request(`${WORKER_ORIGIN}/v1/page/${PAGE_ID}`, {
    headers: noCache ? { "Cache-Control": "no-cache" } : {},
  });

let consoleError: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("에러 응답 변환 (handleRequest)", () => {
  it("/v1/page 요청 중 노션이 1015를 주면 503, Retry-After, JSON 본문, CORS 헤더가 온다", async () => {
    mockNotion({ loadPageChunk: () => rateLimited("30") });
    const { context } = createContext(createCache());

    const res = await handleRequest(pageRequest(), context);

    expect(res.status).toBe(503);
    expect(res.headers.get("Retry-After")).toBe("30");
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
    expect(res.headers.get("Content-Type")).toBe("application/json");
    expect(await res.json()).toEqual({
      error: {
        code: "NOTION_RATE_LIMITED",
        message: expect.any(String),
        upstreamStatus: 429,
        resource: "loadPageChunk",
      },
    });
    expect(consoleError).toHaveBeenCalledTimes(1);
    expect(consoleError.mock.calls[0][0]).toContain("resource=loadPageChunk");
    expect(consoleError.mock.calls[0][0]).toContain("upstreamStatus=429");
    expect(consoleError.mock.calls[0][0]).toContain("error code: 1015");
  });

  it("노션이 호출 제한을 걸면서 Retry-After를 주지 않으면 Retry-After 60을 쓴다", async () => {
    mockNotion({ loadPageChunk: () => rateLimited() });
    const { context } = createContext(createCache());

    const res = await handleRequest(pageRequest(), context);

    expect(res.status).toBe(503);
    expect(res.headers.get("Retry-After")).toBe("60");
  });

  it("노션이 500을 주면 502 NOTION_UPSTREAM_ERROR가 온다", async () => {
    mockNotion({
      loadPageChunk: () =>
        new Response("internal error", {
          status: 500,
          headers: { "content-type": "text/plain" },
        }),
    });
    const { context } = createContext(createCache());

    const res = await handleRequest(pageRequest(), context);

    expect(res.status).toBe(502);
    expect(res.headers.get("Retry-After")).toBeNull();
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
    expect(await res.json()).toEqual({
      error: {
        code: "NOTION_UPSTREAM_ERROR",
        message: expect.any(String),
        upstreamStatus: 500,
        resource: "loadPageChunk",
      },
    });
  });

  it("노션이 4xx를 주면 그대로 넘기지 않고 502로 바꾼다", async () => {
    mockNotion({
      loadPageChunk: () =>
        new Response(
          JSON.stringify({ errorId: "x", name: "ValidationError" }),
          {
            status: 400,
            headers: { "content-type": "application/json" },
          }
        ),
    });
    const { context } = createContext(createCache());

    const res = await handleRequest(pageRequest(), context);

    expect(res.status).toBe(502);
    expect((await res.json()).error.upstreamStatus).toBe(400);
  });

  it("핸들러 안에서 일반 예외가 나면 500 INTERNAL_ERROR JSON이 온다", async () => {
    // 노션 호출 자체가 네트워크 오류로 reject되면 NotionApiError가 아닌 일반 TypeError다.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("fetch failed");
      })
    );
    const { context } = createContext(createCache());

    const res = await handleRequest(pageRequest(), context);

    expect(res.status).toBe(500);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
    expect(await res.json()).toEqual({
      error: { code: "INTERNAL_ERROR", message: expect.any(String) },
    });
    expect(consoleError.mock.calls[0][0]).toContain("INTERNAL_ERROR");
  });

  it("fetch 이벤트 리스너가 handleRequest 결과를 respondWith에 넘긴다", async () => {
    mockNotion({ loadPageChunk: () => rateLimited("5") });
    vi.stubGlobal("caches", { default: createCache() });

    expect(fetchListener).toBeTypeOf("function");
    let responded: Promise<Response> | undefined;
    fetchListener({
      request: pageRequest(),
      respondWith: (p: Promise<Response>) => {
        responded = p;
      },
      waitUntil: () => {},
    });

    const res = await responded!;
    expect(res.status).toBe(503);
    expect(res.headers.get("Retry-After")).toBe("5");
  });
});

describe("읽을 수 없는 페이지 판정", () => {
  const pageChunkWith = (block: Record<string, unknown>) =>
    notionJson({ cursor: { stack: [] }, recordMap: { block } });

  const expectNotAccessible = async (res: Response) => {
    expect(res.status).toBe(404);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
    expect(await res.json()).toEqual({
      error: {
        code: "NOTION_PAGE_NOT_ACCESSIBLE",
        message: "노션 페이지를 찾을 수 없거나 웹에 게시되지 않았습니다.",
        pageId: PAGE_ID,
      },
    });
  };

  it("페이지 블록이 { value: { role: none } }이면 404 NOTION_PAGE_NOT_ACCESSIBLE이 온다", async () => {
    const fetchMock = mockNotion({
      loadPageChunk: () =>
        pageChunkWith({
          [PAGE_ID]: { value: { role: "none" }, spaceId: "space-1" },
        }),
    });
    const { context } = createContext(createCache());

    const res = await handleRequest(pageRequest(), context);

    await expectNotAccessible(res);
    expect(calledResources(fetchMock)).toEqual(["loadPageChunk"]);
  });

  it("응답에 요청한 페이지 블록 키가 없으면 404가 온다", async () => {
    mockNotion({
      loadPageChunk: () =>
        pageChunkWith({
          "other-block": doubleNested({ id: "other-block", type: "text" }),
        }),
    });
    const { context } = createContext(createCache());

    const res = await handleRequest(pageRequest(), context);

    await expectNotAccessible(res);
  });

  it("읽을 수 있는 블록이 없어 노션이 block 키를 뺀 실제 응답을 주면 404가 온다", async () => {
    // 없는 pageId로 실제 노션 loadPageChunk를 불렀을 때 받은 본문 그대로
    mockNotion({
      loadPageChunk: () =>
        notionJson({ cursor: { stack: [] }, recordMap: { __version__: 3 } }),
    });
    const { context } = createContext(createCache());

    const res = await handleRequest(pageRequest(), context);

    await expectNotAccessible(res);
  });

  it("이중 중첩 형식에서 페이지가 alive: false이면 404가 온다", async () => {
    mockNotion({
      loadPageChunk: () =>
        pageChunkWith({
          [PAGE_ID]: doubleNested({
            id: PAGE_ID,
            type: "page",
            alive: false,
            content: ["child-1"],
          }),
        }),
    });
    const { context } = createContext(createCache());

    const res = await handleRequest(pageRequest(), context);

    await expectNotAccessible(res);
  });

  it("하위 블록이 role: none이어도 요청한 페이지가 정상이면 200으로 그대로 돌려준다", async () => {
    mockNotion({
      loadPageChunk: () =>
        pageChunkWith({
          [PAGE_ID]: doubleNested({
            id: PAGE_ID,
            type: "page",
            content: ["child-1"],
          }),
          "child-1": { value: { role: "none" } },
        }),
    });
    const { context } = createContext(createCache());

    const res = await handleRequest(pageRequest(), context);

    expect(res.status).toBe(200);
    expect((await res.json())["child-1"]).toEqual({ value: { role: "none" } });
  });

  it("recordMap이 없는 200 JSON이면 502 NOTION_UPSTREAM_ERROR가 온다", async () => {
    mockNotion({ loadPageChunk: () => notionJson({ cursor: { stack: [] } }) });
    const { context } = createContext(createCache());

    const res = await handleRequest(pageRequest(), context);

    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({
      error: {
        code: "NOTION_UPSTREAM_ERROR",
        message: expect.any(String),
        upstreamStatus: 200,
        resource: "loadPageChunk",
      },
    });
  });

  it("404 응답은 캐시 키가 있어도 cache.put하지 않는다", async () => {
    mockNotion({
      loadPageChunk: () =>
        pageChunkWith({ [PAGE_ID]: { value: { role: "none" } } }),
    });
    const cache = createCache();
    const { context } = createContext(cache);

    const res = await handleRequest(pageRequest(false), context);

    expect(res.status).toBe(404);
    expect(cache.match).toHaveBeenCalledTimes(1);
    expect(cache.put).not.toHaveBeenCalled();
  });
});

describe("page 라우트 노션 호출", () => {
  it("조상 collection_view 블록이 딸려 와도 loadPageChunk 1번만 호출하고 그 블록에 collection 필드를 붙이지 않는다", async () => {
    const COURSE_PAGE_ID = "22222222-2222-2222-2222-222222222222";
    const COLLECTION_VIEW_BLOCK_ID = "33333333-3333-3333-3333-333333333333";
    const CHILD_ID = "44444444-4444-4444-4444-444444444444";

    const collectionViewBlock = doubleNested({
      id: COLLECTION_VIEW_BLOCK_ID,
      type: "collection_view",
      view_ids: ["view-1"],
      collection_id: "collection-1",
      parent_id: COURSE_PAGE_ID,
    });

    const fetchMock = mockNotion({
      loadPageChunk: () =>
        notionJson({
          cursor: { stack: [] },
          recordMap: {
            block: {
              [PAGE_ID]: doubleNested({
                id: PAGE_ID,
                type: "page",
                content: [CHILD_ID],
                parent_id: "collection-1",
                parent_table: "collection",
              }),
              [CHILD_ID]: doubleNested({
                id: CHILD_ID,
                type: "text",
                parent_id: PAGE_ID,
              }),
              [COLLECTION_VIEW_BLOCK_ID]: collectionViewBlock,
              // 코스 최상위 페이지: 요청한 페이지가 아니므로 하위 블록을 받지 않는다.
              [COURSE_PAGE_ID]: doubleNested({
                id: COURSE_PAGE_ID,
                type: "page",
                content: [COLLECTION_VIEW_BLOCK_ID, "not-loaded-block"],
              }),
            },
            collection: {
              "collection-1": doubleNested({
                id: "collection-1",
                name: [["강의자료"]],
                schema: {},
              }),
            },
            collection_view: {
              "view-1": doubleNested({ id: "view-1", type: "table" }),
            },
          },
        }),
    });
    const { context } = createContext(createCache());

    const res = await handleRequest(pageRequest(), context);

    expect(res.status).toBe(200);
    expect(calledResources(fetchMock)).toEqual(["loadPageChunk"]);

    const body = await res.json();
    expect(Object.keys(body).sort()).toEqual(
      [PAGE_ID, CHILD_ID, COLLECTION_VIEW_BLOCK_ID, COURSE_PAGE_ID].sort()
    );
    expect(body[COLLECTION_VIEW_BLOCK_ID]).not.toHaveProperty("collection");
    expect(body[COLLECTION_VIEW_BLOCK_ID]).toEqual(collectionViewBlock);
  });

  it("이중 중첩 페이지에서 빠진 하위 블록을 syncRecordValues로 100개씩 나눠 받아 합친다", async () => {
    const childIds = Array.from(
      { length: 150 },
      (_, i) => `child-${String(i).padStart(3, "0")}`
    );
    const GRANDCHILD_ID = "grandchild-000";

    const fetchMock = mockNotion({
      loadPageChunk: () =>
        notionJson({
          cursor: { stack: [] },
          recordMap: {
            block: {
              [PAGE_ID]: doubleNested({
                id: PAGE_ID,
                type: "page",
                content: childIds,
              }),
            },
          },
        }),
      syncRecordValues: (body) =>
        notionJson({
          recordMap: {
            block: Object.fromEntries(
              body.requests.map(({ id }: { id: string }) => [
                id,
                doubleNested({
                  id,
                  type: "text",
                  // 첫 하위 블록만 자기 하위 블록을 가진다(다음 바퀴에서 받아야 함).
                  ...(id === childIds[0] ? { content: [GRANDCHILD_ID] } : {}),
                }),
              ])
            ),
          },
        }),
    });
    const { context } = createContext(createCache());

    const res = await handleRequest(pageRequest(), context);

    expect(res.status).toBe(200);
    expect(calledResources(fetchMock)).toEqual([
      "loadPageChunk",
      "syncRecordValues",
      "syncRecordValues",
      "syncRecordValues",
    ]);
    const requestSizes = fetchMock.mock.calls
      .slice(1)
      .map((c) => JSON.parse(String(c[1]?.body)).requests.length);
    expect(requestSizes).toEqual([100, 50, 1]);

    const body = await res.json();
    expect(Object.keys(body)).toHaveLength(1 + 150 + 1);
    expect(body[childIds[149]]).toEqual(
      doubleNested({ id: childIds[149], type: "text" })
    );
    expect(body[GRANDCHILD_ID].value.value.id).toBe(GRANDCHILD_ID);
  });

  it("syncRecordValues가 요청한 블록 일부를 돌려주지 않아도 루프가 끝나고 같은 id를 다시 요청하지 않는다", async () => {
    const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const fetchMock = mockNotion({
      loadPageChunk: () =>
        notionJson({
          cursor: { stack: [] },
          recordMap: {
            block: {
              [PAGE_ID]: doubleNested({
                id: PAGE_ID,
                type: "page",
                content: ["child-1", "missing-1", "child-2"],
              }),
            },
          },
        }),
      // child-1의 하위 블록 중 missing-2도 돌려주지 않는다.
      syncRecordValues: (body) => {
        const known: Record<string, unknown> = {
          "child-1": doubleNested({
            id: "child-1",
            type: "toggle",
            content: ["missing-2", "missing-1"],
          }),
          "child-2": doubleNested({ id: "child-2", type: "text" }),
        };
        return notionJson({
          recordMap: {
            block: Object.fromEntries(
              body.requests
                .map(({ id }: { id: string }) => id)
                .filter((id: string) => known[id])
                .map((id: string) => [id, known[id]])
            ),
          },
        });
      },
    });
    const { context } = createContext(createCache());

    const res = await handleRequest(pageRequest(), context);

    expect(res.status).toBe(200);
    const requestedIds = fetchMock.mock.calls
      .filter((c) => String(c[0]).endsWith("/syncRecordValues"))
      .map((c) =>
        JSON.parse(String(c[1]?.body)).requests.map(
          ({ id }: { id: string }) => id
        )
      );
    // 1회차: 페이지의 하위 블록 3개, 2회차: child-1의 하위 중 아직 요청하지 않은 missing-2만.
    expect(requestedIds).toEqual([
      ["child-1", "missing-1", "child-2"],
      ["missing-2"],
    ]);
    expect(Object.keys(await res.json()).sort()).toEqual(
      [PAGE_ID, "child-1", "child-2"].sort()
    );
    expect(consoleWarn).toHaveBeenCalledTimes(1);
    expect(consoleWarn.mock.calls[0][0]).toContain(`pageId=${PAGE_ID}`);
    expect(consoleWarn.mock.calls[0][0]).toContain("missing=2");
  });

  it("syncRecordValues가 block 키 없는 recordMap을 주면 502가 아니라 200이고 루프가 끝난다", async () => {
    const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const fetchMock = mockNotion({
      loadPageChunk: () =>
        notionJson({
          cursor: { stack: [] },
          recordMap: {
            block: {
              [PAGE_ID]: doubleNested({
                id: PAGE_ID,
                type: "page",
                content: ["child-1", "child-2"],
              }),
            },
          },
        }),
      syncRecordValues: () => notionJson({ recordMap: { __version__: 3 } }),
    });
    const { context } = createContext(createCache());

    const res = await handleRequest(pageRequest(), context);

    expect(res.status).toBe(200);
    expect(calledResources(fetchMock)).toEqual([
      "loadPageChunk",
      "syncRecordValues",
    ]);
    expect(Object.keys(await res.json())).toEqual([PAGE_ID]);
    expect(consoleWarn).toHaveBeenCalledTimes(1);
    expect(consoleWarn.mock.calls[0][0]).toContain("missing=2");
  });

  it("syncRecordValues가 recordMap 없는 JSON을 주면 502 NOTION_UPSTREAM_ERROR가 온다", async () => {
    mockNotion({
      loadPageChunk: () =>
        notionJson({
          cursor: { stack: [] },
          recordMap: {
            block: {
              [PAGE_ID]: doubleNested({
                id: PAGE_ID,
                type: "page",
                content: ["child-1"],
              }),
            },
          },
        }),
      syncRecordValues: () => notionJson({}),
    });
    const { context } = createContext(createCache());

    const res = await handleRequest(pageRequest(), context);

    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({
      error: {
        code: "NOTION_UPSTREAM_ERROR",
        message: expect.any(String),
        upstreamStatus: 200,
        resource: "syncRecordValues",
      },
    });
  });

  it("하위 블록을 받는 중 노션이 1015를 주면 503이 온다", async () => {
    mockNotion({
      loadPageChunk: () =>
        notionJson({
          cursor: { stack: [] },
          recordMap: {
            block: {
              [PAGE_ID]: doubleNested({
                id: PAGE_ID,
                type: "page",
                content: ["child-1"],
              }),
            },
          },
        }),
      syncRecordValues: () => rateLimited("12"),
    });
    const { context } = createContext(createCache());

    const res = await handleRequest(pageRequest(), context);

    expect(res.status).toBe(503);
    expect(res.headers.get("Retry-After")).toBe("12");
    expect((await res.json()).error.resource).toBe("syncRecordValues");
  });
});

describe("응답 캐시", () => {
  const okPage = () =>
    notionJson({
      cursor: { stack: [] },
      recordMap: {
        block: { [PAGE_ID]: doubleNested({ id: PAGE_ID, type: "page" }) },
      },
    });

  it("에러 응답은 캐시 키가 있어도 cache.put하지 않는다", async () => {
    mockNotion({ loadPageChunk: () => rateLimited("30") });
    const cache = createCache();
    const { context } = createContext(cache);

    const res = await handleRequest(pageRequest(false), context);

    expect(res.status).toBe(503);
    expect(cache.match).toHaveBeenCalledTimes(1);
    expect(cache.put).not.toHaveBeenCalled();
  });

  it("200 응답은 캐시 키가 있을 때 cache.put한다", async () => {
    mockNotion({ loadPageChunk: okPage });
    const cache = createCache();
    const { context } = createContext(cache);

    const res = await handleRequest(pageRequest(false), context);

    expect(res.status).toBe(200);
    expect(cache.put).toHaveBeenCalledTimes(1);
    expect(cache.put.mock.calls[0][0]).toBe(
      `${WORKER_ORIGIN}/v1/page/${PAGE_ID}`
    );
    // 캐시에는 복제본을 넣으므로 원래 응답 본문도 그대로 읽힌다.
    expect(Object.keys(await res.json())).toEqual([PAGE_ID]);
  });

  it("Cache-Control: no-cache 요청은 캐시 키가 없어 200이어도 cache.put하지 않는다", async () => {
    mockNotion({ loadPageChunk: okPage });
    const cache = createCache();
    const { context } = createContext(cache);

    const res = await handleRequest(pageRequest(true), context);

    expect(res.status).toBe(200);
    expect(cache.match).not.toHaveBeenCalled();
    expect(cache.put).not.toHaveBeenCalled();
  });

  it("OPTIONS 요청은 cache.match도 cache.put도 하지 않는다", async () => {
    const fetchMock = mockNotion({});
    const cache = createCache();
    const { context } = createContext(cache);

    const res = await handleRequest(
      new Request(`${WORKER_ORIGIN}/v1/page/${PAGE_ID}`, { method: "OPTIONS" }),
      context
    );

    expect(res.status).toBe(200);
    expect(cache.match).not.toHaveBeenCalled();
    expect(cache.put).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("캐시 적중 후 백그라운드 갱신이 실패해도 rejection이 나지 않고 기존 캐시를 덮어쓰지 않는다", async () => {
    mockNotion({ loadPageChunk: () => rateLimited("30") });
    const cached = new Response(JSON.stringify({ cached: true }), {
      status: 200,
    });
    const cache = createCache(cached);
    const { context, pending } = createContext(cache);

    const res = await handleRequest(pageRequest(false), context);

    expect(res).toBe(cached);
    expect(pending).toHaveLength(1);
    await expect(pending[0]).resolves.toBeInstanceOf(Response);
    expect(cache.put).not.toHaveBeenCalled();
  });

  it("캐시 적중 후 백그라운드 갱신에서 cache.put이 실패해도 rejection이 나지 않는다", async () => {
    mockNotion({ loadPageChunk: okPage });
    const cache = createCache(new Response("{}", { status: 200 }));
    cache.put.mockRejectedValueOnce(new Error("cache unavailable"));
    const { context, pending } = createContext(cache);

    await handleRequest(pageRequest(false), context);

    await expect(pending[0]).resolves.toBeInstanceOf(Response);
    expect(cache.put).toHaveBeenCalledTimes(1);
  });
});
