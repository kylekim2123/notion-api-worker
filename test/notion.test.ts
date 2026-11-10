import { afterEach, describe, expect, it, vi } from "vitest";

import { fetchPageById, NotionApiError } from "../src/api/notion";

const PAGE_ID = "11111111-1111-1111-1111-111111111111";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("노션 응답 검증 (fetchNotionData)", () => {
  it("노션이 429와 평문 error code: 1015를 주면 호출 제한 NotionApiError가 나고 Retry-After를 읽는다", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response("error code: 1015\n", {
            status: 429,
            headers: { "content-type": "text/plain", "retry-after": "30" },
          })
      )
    );

    const err = await fetchPageById(PAGE_ID).catch((e) => e);

    expect(err).toBeInstanceOf(NotionApiError);
    expect(err.resource).toBe("loadPageChunk");
    expect(err.status).toBe(429);
    expect(err.isRateLimited).toBe(true);
    expect(err.retryAfterSeconds).toBe(30);
    expect(err.bodySnippet).toBe("error code: 1015\n");
  });

  it("상태가 429가 아니어도 본문에 error code: 1015가 있으면 호출 제한으로 보고, Retry-After가 없으면 null이다", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response("error code: 1015", {
            status: 403,
            headers: { "content-type": "text/plain" },
          })
      )
    );

    const err = await fetchPageById(PAGE_ID).catch((e) => e);

    expect(err).toBeInstanceOf(NotionApiError);
    expect(err.isRateLimited).toBe(true);
    expect(err.retryAfterSeconds).toBeNull();
  });

  it("노션이 200인데 JSON이 아닌 본문을 주면 NotionApiError가 난다", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response("<html>maintenance</html>", {
            status: 200,
            headers: { "content-type": "text/html" },
          })
      )
    );

    const err = await fetchPageById(PAGE_ID).catch((e) => e);

    expect(err).toBeInstanceOf(NotionApiError);
    expect(err.status).toBe(200);
    expect(err.isRateLimited).toBe(false);
    expect(err.bodySnippet).toBe("<html>maintenance</html>");
  });

  it("Content-Type은 JSON인데 본문 파싱이 실패해도 NotionApiError가 난다", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response("{not json", {
            status: 200,
            headers: { "content-type": "application/json" },
          })
      )
    );

    const err = await fetchPageById(PAGE_ID).catch((e) => e);

    expect(err).toBeInstanceOf(NotionApiError);
    expect(err.status).toBe(200);
  });

  it("본문 앞부분은 최대 200자까지만 담는다", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response("x".repeat(500), {
            status: 500,
            headers: { "content-type": "text/plain" },
          })
      )
    );

    const err = await fetchPageById(PAGE_ID).catch((e) => e);

    expect(err).toBeInstanceOf(NotionApiError);
    expect(err.isRateLimited).toBe(false);
    expect(err.bodySnippet).toHaveLength(200);
  });
});
