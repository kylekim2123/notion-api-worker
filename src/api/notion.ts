import {
  JSONData,
  NotionUserType,
  LoadPageChunkData,
  CollectionData,
  NotionSearchParamsType,
  NotionSearchResultsType,
} from "./types";

const NOTION_API = "https://www.notion.so/api/v3";

interface INotionParams {
  resource: string;
  body: JSONData;
  notionToken?: string;
  baseUrl?: string;
}

const loadPageChunkBody = {
  limit: 100,
  cursor: { stack: [] },
  chunkNumber: 0,
  verticalColumns: false,
};

// 에러에 담을 노션 응답 본문의 최대 길이
const BODY_SNIPPET_MAX_LENGTH = 200;

// Cloudflare가 호출 제한 시 돌려주는 평문 본문의 표식
const RATE_LIMIT_BODY_MARKER = "error code: 1015";

interface NotionApiErrorParams {
  resource: string;
  status: number;
  isRateLimited: boolean;
  retryAfterSeconds: number | null;
  bodySnippet: string;
  reason: string;
}

/**
 * 노션 API가 실패 상태를 돌려주거나 JSON이 아닌 응답을 줄 때 던지는 에러.
 * index.ts가 이 에러를 보고 503(호출 제한) 또는 502(그 밖의 노션 오류)로 바꾼다.
 */
export class NotionApiError extends Error {
  readonly resource: string;
  readonly status: number;
  readonly isRateLimited: boolean;
  readonly retryAfterSeconds: number | null;
  readonly bodySnippet: string;

  constructor(params: NotionApiErrorParams) {
    super(
      `Notion API ${params.resource} 실패 (status=${params.status}): ${params.reason}`
    );
    this.name = "NotionApiError";
    this.resource = params.resource;
    this.status = params.status;
    this.isRateLimited = params.isRateLimited;
    this.retryAfterSeconds = params.retryAfterSeconds;
    this.bodySnippet = params.bodySnippet;
  }
}

/**
 * 요청한 페이지를 읽을 수 없을 때 던지는 에러(웹 미게시, 삭제, 존재하지 않음).
 * 노션은 이런 경우에도 200과 권한 없음 레코드({ role: "none" })를 주므로 직접 판정한다.
 * index.ts가 이 에러를 404로 바꾼다.
 */
export class NotionPageNotAccessibleError extends Error {
  readonly pageId: string;

  constructor(pageId: string, reason: string) {
    super(`노션 페이지 ${pageId}를 읽을 수 없음: ${reason}`);
    this.name = "NotionPageNotAccessibleError";
    this.pageId = pageId;
  }
}

// Retry-After 헤더를 초 단위로 읽는다. 초 숫자와 HTTP 날짜 형식을 모두 받고, 없거나 읽을 수 없으면 null.
const parseRetryAfter = (value: string | null): number | null => {
  if (value === null || value.trim() === "") {
    return null;
  }

  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) {
    return Number(trimmed);
  }

  const date = Date.parse(trimmed);
  if (Number.isNaN(date)) {
    return null;
  }

  return Math.max(0, Math.ceil((date - Date.now()) / 1000));
};

const fetchNotionData = async <T extends any>({
  resource,
  body,
  notionToken,
  baseUrl = NOTION_API,
}: INotionParams): Promise<T> => {
  const url = `${baseUrl}/${resource}`;
  
  const spaceId = (body as any)?.spaceId;
  
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(notionToken && { cookie: `token_v2=${notionToken}` }),
      ...(spaceId && { "x-notion-space-id": spaceId }),
    },
    body: JSON.stringify(body),
  });

  // 본문은 한 번만 읽을 수 있으므로 텍스트로 받아 두고 검증 후 직접 파싱한다.
  const text = await res.text();
  const contentType = res.headers.get("content-type") || "";

  const createError = (reason: string) =>
    new NotionApiError({
      resource,
      status: res.status,
      isRateLimited:
        res.status === 429 || text.includes(RATE_LIMIT_BODY_MARKER),
      retryAfterSeconds: parseRetryAfter(res.headers.get("retry-after")),
      bodySnippet: text.slice(0, BODY_SNIPPET_MAX_LENGTH),
      reason,
    });

  if (!res.ok) {
    throw createError("HTTP 상태가 2xx가 아님");
  }

  if (!contentType.toLowerCase().includes("json")) {
    throw createError(`JSON이 아닌 Content-Type(${contentType || "없음"})`);
  }

  try {
    return JSON.parse(text) as T;
  } catch (e) {
    throw createError("JSON 파싱 실패");
  }
};

export const fetchPageById = async (pageId: string, notionToken?: string) => {
  const res = await fetchNotionData<LoadPageChunkData>({
    resource: "loadPageChunk",
    body: {
      pageId,
      ...loadPageChunkBody,
    },
    notionToken,
  });

  return res;
};

const queryCollectionBody = {
  loader: {
    type: "reducer",
    reducers: {
      collection_group_results: {
        type: "results",
        limit: 999,
        loadContentCover: true,
      },
      "table:uncategorized:title:count": {
        type: "aggregation",
        aggregation: {
          property: "title",
          aggregator: "count",
        },
      },
    },
    searchQuery: "",
    userTimeZone: "Europe/Vienna",
  },
};

export const fetchTableData = async (
  collectionId: string,
  collectionViewId: string,
  notionToken?: string,
  spaceId?: string,
  siteId?: string
) => {
  const apiBaseUrl = siteId
    ? `https://${siteId}.notion.site/api/v3`
    : NOTION_API;

  const requestBody: JSONData = {
    ...(spaceId ? { spaceId } : {}),
    collection: {
      id: collectionId,
    },
    collectionView: {
      id: collectionViewId,
    },
    ...queryCollectionBody,
  };

  const table = await fetchNotionData<CollectionData>({
    resource: "queryCollection",
    body: requestBody,
    notionToken,
    baseUrl: apiBaseUrl,
  });

  return table;
};

export const fetchNotionUsers = async (
  userIds: string[],
  notionToken?: string
) => {
  const users = await fetchNotionData<{ results: NotionUserType[] }>({
    resource: "getRecordValues",
    body: {
      requests: userIds.map((id) => ({ id, table: "notion_user" })),
    },
    notionToken,
  });
  if (users && users.results) {
    return users.results.map((u) => {
      const user = {
        id: u.value.id,
        firstName: u.value.given_name,
        lastLame: u.value.family_name,
        fullName: u.value.given_name + " " + u.value.family_name,
        profilePhoto: u.value.profile_photo,
      };
      return user;
    });
  }
  return [];
};

export const fetchBlocks = async (
  blockList: string[],
  notionToken?: string
) => {
  return await fetchNotionData<LoadPageChunkData>({
    resource: "syncRecordValues",
    body: {
      requests: blockList.map((id) => ({
        id,
        table: "block",
        version: -1,
      })),
    },
    notionToken,
  });
};

export const fetchNotionSearch = async (
  params: NotionSearchParamsType,
  notionToken?: string
) => {
  // TODO: support other types of searches
  return fetchNotionData<{ results: NotionSearchResultsType }>({
    resource: "search",
    body: {
      type: "BlocksInAncestor",
      source: "quick_find_public",
      ancestorId: params.ancestorId,
      filters: {
        isDeletedOnly: false,
        excludeTemplates: true,
        isNavigableOnly: true,
        requireEditPermissions: false,
        ancestors: [],
        createdBy: [],
        editedBy: [],
        lastEditedTime: {},
        createdTime: {},
        ...params.filters,
      },
      sort: "Relevance",
      limit: params.limit || 20,
      query: params.query,
    },
    notionToken,
  });
};
