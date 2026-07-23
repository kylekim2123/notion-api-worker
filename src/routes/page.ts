import { fetchPageById, fetchBlocks } from "../api/notion";
import { parsePageId } from "../api/utils";
import { createResponse } from "../response";
import { getTableData } from "./table";
import { BlockType, CollectionType, HandlerRequest } from "../api/types";

export async function pageRoute(req: HandlerRequest) {
  const pageId = parsePageId(req.params.pageId);
  const page = await fetchPageById(pageId!, req.notionToken);

  // Notion now double-nests each record as { value: { value: <block>, role } }.
  // Unwrap to the actual block, falling back to the old single-nested shape.
  const val = (rec: any) => rec?.value?.value ?? rec?.value;

  const pageBlock = page.recordMap.block[pageId!];
  const spaceId = val(pageBlock)?.space_id;
  const siteId = val(pageBlock)?.format?.site_id;

  const baseBlocks = page.recordMap.block;

  let allBlocks: { [id: string]: BlockType & { collection?: any } } = {
    ...baseBlocks,
  };
  let allBlockKeys;

  while (true) {
    allBlockKeys = Object.keys(allBlocks);

    const pendingBlocks = allBlockKeys.flatMap((blockId) => {
      const block = val(allBlocks[blockId]);
      const content = block && block.content;

      if (!content || (block.type === "page" && blockId !== pageId!)) {
        // skips pages other than the requested page
        return [];
      }

      return content.filter((id: string) => !allBlocks[id]);
    });

    if (!pendingBlocks.length) {
      break;
    }

    // Batch to avoid oversized syncRecordValues requests on large pages.
    const newBlocks: { [id: string]: BlockType } = {};
    for (let i = 0; i < pendingBlocks.length; i += 100) {
      const res = await fetchBlocks(pendingBlocks.slice(i, i + 100), req.notionToken);
      Object.assign(newBlocks, res.recordMap.block);
    }

    allBlocks = { ...allBlocks, ...newBlocks };
  }

  const collection = page.recordMap.collection
    ? page.recordMap.collection[Object.keys(page.recordMap.collection)[0]]
    : null;

  const collectionView = page.recordMap.collection_view
    ? page.recordMap.collection_view[
        Object.keys(page.recordMap.collection_view)[0]
      ]
    : null;

  if (collection && collectionView) {
    const pendingCollections = allBlockKeys.flatMap((blockId) => {
      const b = val(allBlocks[blockId]);

      return (b && b.type === "collection_view") ? [b.id] : [];
    });

    for (let b of pendingCollections) {
      // Collection/table enrichment is best-effort: never let it fail the
      // whole page (the main content blocks must still be returned).
      try {
        const collPage = await fetchPageById(b!, req.notionToken);

        const coll = Object.keys(collPage.recordMap.collection).map(
          (k) => collPage.recordMap.collection[k]
        )[0];

        const collView: {
          value: { id: CollectionType["value"]["id"] };
        } = Object.keys(collPage.recordMap.collection_view).map(
          (k) => collPage.recordMap.collection_view[k]
        )[0];

        const { rows, schema } = await getTableData(
          coll,
          val(collView).id,
          req.notionToken,
          true,
          spaceId,
          siteId
        );

        const viewIds = val(allBlocks[b]).view_ids as string[];

        allBlocks[b] = {
          ...allBlocks[b],
          collection: {
            title: val(coll).name,
            schema,
            types: viewIds.map((id) => {
              const col = collPage.recordMap.collection_view[id];
              return col ? val(col) : undefined;
            }),
            data: rows,
          },
        };
      } catch (e) {
        console.error("collection enrichment skipped for block " + b, e);
      }
    }
  }

  return createResponse(allBlocks);
}
