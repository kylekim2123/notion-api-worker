import {} from "@cloudflare/workers-types";
import { Router, Method } from "tiny-request-router";

import { pageRoute } from "./routes/page";
import { tableRoute } from "./routes/table";
import { userRoute } from "./routes/user";
import { searchRoute } from "./routes/search";
import { createResponse } from "./response";
import { getCacheKey } from "./get-cache-key";
import { NotionApiError, NotionPageNotAccessibleError } from "./api/notion";
import * as types from "./api/types";

export type Handler = (
  req: types.HandlerRequest
) => Promise<Response> | Response;

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "*",
  "Access-Control-Allow-Methods": "GET, HEAD, POST, OPTIONS",
};

const router = new Router<Handler>();

router.options("*", () => new Response(null, { headers: corsHeaders }));
router.get("/v1/page/:pageId", pageRoute);
router.get("/v1/table/:pageId", tableRoute);
router.get("/v1/user/:userId", userRoute);
router.get("/v1/search", searchRoute);

router.get("*", async () =>
  createResponse(
    {
      error: `Route not found!`,
      routes: ["/v1/page/:pageId", "/v1/table/:pageId", "/v1/user/:pageId"],
    },
    {},
    404
  )
);

const NOTION_API_TOKEN =
  typeof NOTION_TOKEN !== "undefined" ? NOTION_TOKEN : undefined;

// 노션이 호출 제한을 걸면서 Retry-After를 주지 않았을 때 쓰는 기본값(초)
const DEFAULT_RETRY_AFTER_SECONDS = 60;

type ErrorCode =
  | "NOTION_RATE_LIMITED"
  | "NOTION_UPSTREAM_ERROR"
  | "NOTION_PAGE_NOT_ACCESSIBLE"
  | "INTERNAL_ERROR";

// Cloudflare caches.default 중 이 워커가 쓰는 부분만 뽑은 형태. 테스트에서 가짜로 바꿔 끼운다.
export interface CacheLike {
  match(key: string): Promise<Response | undefined>;
  put(key: string, response: Response): Promise<unknown>;
}

export interface HandleRequestContext {
  cache: CacheLike;
  waitUntil: (promise: Promise<unknown>) => void;
}

const createErrorResponse = (
  code: ErrorCode,
  message: string,
  status: number,
  extra: { upstreamStatus?: number; resource?: string; pageId?: string } = {},
  headers: { [key: string]: string } = {}
) => createResponse({ error: { code, message, ...extra } }, headers, status);

/**
 * 핸들러에서 난 예외를 JSON 에러 응답으로 바꾼다. 이 함수는 예외를 던지지 않는다.
 * - 노션 호출 제한 → 503 + Retry-After
 * - 그 밖의 노션 오류(4xx, 5xx, 비JSON, 형식이 깨진 응답) → 502
 * - 요청한 페이지를 읽을 수 없음(웹 미게시, 삭제) → 404
 * - 그 밖의 예외 → 500
 */
export const toErrorResponse = (err: unknown, request: Request): Response => {
  const path = (() => {
    try {
      return new URL(request.url).pathname;
    } catch (e) {
      return request.url;
    }
  })();

  if (err instanceof NotionApiError) {
    const retryAfter = err.isRateLimited
      ? (err.retryAfterSeconds ?? DEFAULT_RETRY_AFTER_SECONDS)
      : null;
    const code: ErrorCode = err.isRateLimited
      ? "NOTION_RATE_LIMITED"
      : "NOTION_UPSTREAM_ERROR";

    // Cloudflare observability logs에서 한 줄로 찾을 수 있게 남긴다.
    console.error(
      `[notion-api-worker] ${code} path=${path} resource=${err.resource} ` +
        `upstreamStatus=${err.status} retryAfter=${retryAfter} ` +
        `body=${JSON.stringify(err.bodySnippet)}`
    );

    if (retryAfter !== null) {
      return createErrorResponse(
        code,
        "노션 API 호출 제한에 걸렸습니다. 잠시 후 다시 시도하세요.",
        503,
        { upstreamStatus: err.status, resource: err.resource },
        { "Retry-After": String(retryAfter) }
      );
    }

    return createErrorResponse(
      code,
      "노션 API가 올바른 응답을 주지 않았습니다.",
      502,
      { upstreamStatus: err.status, resource: err.resource }
    );
  }

  if (err instanceof NotionPageNotAccessibleError) {
    console.error(
      `[notion-api-worker] NOTION_PAGE_NOT_ACCESSIBLE path=${path} pageId=${err.pageId} ` +
        `reason=${JSON.stringify(err.message)}`
    );

    return createErrorResponse(
      "NOTION_PAGE_NOT_ACCESSIBLE",
      "노션 페이지를 찾을 수 없거나 웹에 게시되지 않았습니다.",
      404,
      { pageId: err.pageId }
    );
  }

  const detail = err instanceof Error ? err.stack || err.message : String(err);
  console.error(
    `[notion-api-worker] INTERNAL_ERROR path=${path} error=${JSON.stringify(detail)}`
  );

  return createErrorResponse(
    "INTERNAL_ERROR",
    "워커 내부에서 처리하지 못한 오류가 발생했습니다.",
    500
  );
};

export const handleRequest = async (
  request: Request,
  { cache, waitUntil }: HandleRequestContext
): Promise<Response> => {
  const { pathname, searchParams } = new URL(request.url);
  const notionToken =
    NOTION_API_TOKEN ||
    (request.headers.get("Authorization") || "").split("Bearer ")[1] ||
    undefined;

  const match = router.match(request.method as Method, pathname);

  if (!match) {
    return new Response("Endpoint not found.", { status: 404 });
  }

  // caches.default는 문자열 키를 GET 요청으로 취급하므로 GET만 캐시를 읽고 쓴다.
  // OPTIONS의 빈 200 응답이 같은 URL의 GET 캐시를 덮어쓰지 않게 하기 위해서다.
  const cacheKey = request.method === "GET" ? getCacheKey(request) : null;
  let response;

  if (cacheKey) {
    try {
      response = await cache.match(cacheKey);
    } catch (err) {}
  }

  // 핸들러 예외는 모두 에러 응답으로 바꾸므로 이 함수는 reject되지 않는다.
  const getResponseAndPersist = async () => {
    let res: Response;
    try {
      res = await match.handler({
        request,
        searchParams,
        params: match.params,
        notionToken,
      });
    } catch (err) {
      return toErrorResponse(err, request);
    }

    // 성공 응답만 캐시한다. 에러 응답으로 기존 캐시를 덮어쓰지 않기 위해서다.
    if (cacheKey && res.status === 200) {
      try {
        await cache.put(cacheKey, res.clone());
      } catch (err) {
        console.error(
          `[notion-api-worker] cache.put 실패 key=${cacheKey} error=${String(err)}`
        );
      }
    }

    return res;
  };

  if (response) {
    // 캐시 적중 시 백그라운드 갱신. 실패해도 처리되지 않은 rejection이 남지 않게 한 번 더 막는다.
    waitUntil(
      getResponseAndPersist().catch((err) => {
        console.error(
          `[notion-api-worker] 백그라운드 갱신 실패 key=${cacheKey} error=${String(err)}`
        );
      })
    );
    return response;
  }

  return getResponseAndPersist();
};

self.addEventListener("fetch", (event: Event) => {
  const fetchEvent = event as FetchEvent;
  const request = fetchEvent.request;
  const context: HandleRequestContext = {
    cache: (caches as any).default,
    waitUntil: (promise) => fetchEvent.waitUntil(promise),
  };

  // 마지막 안전망: 어떤 예외도 워커 밖으로 새지 않게 해 1101을 막는다.
  fetchEvent.respondWith(
    handleRequest(request, context).catch((err) =>
      toErrorResponse(err, request)
    )
  );
});
