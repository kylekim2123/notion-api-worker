import {
  fetchPageById,
  fetchBlocks,
  NotionApiError,
  NotionPageNotAccessibleError,
} from "../api/notion";
import { parsePageId } from "../api/utils";
import { createResponse } from "../response";
import { BlockType, HandlerRequest } from "../api/types";

// 응답의 블록 맵을 꺼낸다. recordMap 자체가 없으면 형식이 깨진 응답으로 보고 502로 알린다.
// 노션은 읽을 수 있는 블록이 하나도 없으면 block 키를 아예 빼고
// { recordMap: { __version__: 3 } }를 주므로, 이때는 빈 블록 맵으로 취급한다.
const getBlockMap = (
  data: any,
  resource: string
): { [id: string]: BlockType } => {
  if (!data || !data.recordMap) {
    throw new NotionApiError({
      resource,
      status: 200,
      isRateLimited: false,
      retryAfterSeconds: null,
      bodySnippet: (JSON.stringify(data) || "").slice(0, 200),
      reason: "recordMap이 없는 응답",
    });
  }

  return data.recordMap.block || {};
};

export async function pageRoute(req: HandlerRequest) {
  const pageId = parsePageId(req.params.pageId);
  const page = await fetchPageById(pageId!, req.notionToken);

  // Notion now double-nests each record as { value: { value: <block>, role } }.
  // Unwrap to the actual block, falling back to the old single-nested shape.
  const val = (rec: any) => rec?.value?.value ?? rec?.value;

  const baseBlocks = getBlockMap(page, "loadPageChunk");

  // 요청한 페이지 블록 하나만 판정한다. 하위 블록의 role: none은 그대로 둔다.
  const requestedPage = val(baseBlocks[pageId!]);
  if (!requestedPage) {
    throw new NotionPageNotAccessibleError(
      pageId!,
      "페이지 블록이 응답에 없음"
    );
  }
  if (!requestedPage.id || !requestedPage.type) {
    throw new NotionPageNotAccessibleError(
      pageId!,
      "id나 type이 없는 레코드(권한 없음, 웹 미게시)"
    );
  }
  if (requestedPage.alive === false) {
    throw new NotionPageNotAccessibleError(
      pageId!,
      "삭제된 페이지(alive: false)"
    );
  }

  // 조상 collection_view(인라인 DB) 블록은 받은 그대로 둔다. react-notion-x가
  // block.collection을 읽지 않으므로 DB를 다시 조회해 행을 붙이지 않는다(호출 수 절감).
  let allBlocks: { [id: string]: BlockType } = {
    ...baseBlocks,
  };

  // 한 번 요청한 블록 id. 요청했는데 오지 않은 블록을 다시 요청하면 루프가 끝나지 않고
  // 같은 호출이 반복돼 호출 제한을 부르므로, 다음 회차에서는 빼낸다.
  const requestedBlockIds = new Set<string>();
  let missingBlockCount = 0;

  while (true) {
    const allBlockKeys = Object.keys(allBlocks);

    const pendingBlockIds = allBlockKeys.flatMap((blockId) => {
      const block = val(allBlocks[blockId]);
      const content = block && block.content;

      if (!content || (block.type === "page" && blockId !== pageId!)) {
        // skips pages other than the requested page
        return [];
      }

      return content.filter(
        (id: string) => !allBlocks[id] && !requestedBlockIds.has(id)
      );
    });

    // 여러 블록이 같은 하위 블록을 가리켜도 한 번만 요청한다.
    const pendingBlocks = Array.from(new Set<string>(pendingBlockIds));

    if (!pendingBlocks.length) {
      break;
    }

    // Batch to avoid oversized syncRecordValues requests on large pages.
    const newBlocks: { [id: string]: BlockType } = {};
    for (let i = 0; i < pendingBlocks.length; i += 100) {
      const batch = pendingBlocks.slice(i, i + 100);
      batch.forEach((id) => requestedBlockIds.add(id));
      const res = await fetchBlocks(batch, req.notionToken);
      // block 키가 없으면 이번 회차에 받은 블록 0개로 보고 누락 수에 더한다.
      Object.assign(newBlocks, getBlockMap(res, "syncRecordValues"));
    }

    missingBlockCount += pendingBlocks.filter((id) => !newBlocks[id]).length;
    allBlocks = { ...allBlocks, ...newBlocks };
  }

  // 받지 못한 블록은 빼고 받은 블록만으로 응답한다.
  if (missingBlockCount > 0) {
    console.warn(
      `[notion-api-worker] syncRecordValues 누락 블록 pageId=${pageId} missing=${missingBlockCount}`
    );
  }

  return createResponse(allBlocks);
}
