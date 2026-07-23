import { fetchPageById, fetchTableData, fetchNotionUsers } from "../api/notion";
import { parsePageId, getNotionValue } from "../api/utils";
import {
  RowContentType,
  CollectionType,
  RowType,
  HandlerRequest,
} from "../api/types";
import { createResponse } from "../response";

export const getTableData = async (
  collection: CollectionType,
  collectionViewId: string,
  notionToken?: string,
  raw?: boolean,
  spaceId?: string,
  siteId?: string
) => {
  // Notion now double-nests each record as { value: { value: <block>, role } }.
  // Unwrap to the actual value, falling back to the old single-nested shape.
  const unwrap = (rec: any) => rec?.value?.value ?? rec?.value;
  const collectionValue = unwrap(collection);

  const table = await fetchTableData(
    collectionValue.id,
    collectionViewId,
    notionToken,
    spaceId,
    siteId
  );

  const collectionRows = collectionValue.schema;
  const collectionColKeys = Object.keys(collectionRows);

  const tableArr: RowType[] = table.result.reducerResults.collection_group_results.blockIds.map(
    (id: string) => table.recordMap.block[id]
  );

  const tableData = tableArr.filter((b) => {
    const v = unwrap(b);
    return v && v.properties && v.parent_id === collectionValue.id;
  });

  type Row = { id: string; [key: string]: RowContentType };

  const rows: Row[] = [];

  for (const td of tableData) {
    const tv = unwrap(td);
    let row: Row = { id: tv.id };

    for (const key of collectionColKeys) {
      const val = tv.properties[key];
      if (val) {
        const schema = collectionRows[key];
        row[schema.name] = raw ? val : getNotionValue(val, schema.type, td);
        if (schema.type === "person" && row[schema.name]) {
          const users = await fetchNotionUsers(row[schema.name] as string[]);
          row[schema.name] = users as any;
        }
      }
    }
    rows.push(row);
  }

  return { rows, schema: collectionRows };
};

export async function tableRoute(req: HandlerRequest) {
  const pageId = parsePageId(req.params.pageId);
  const page = await fetchPageById(pageId!, req.notionToken);

  if (!page.recordMap.collection)
    return createResponse(
      JSON.stringify({ error: "No table found on Notion page: " + pageId }),
      {},
      401
    );

  const collection = Object.keys(page.recordMap.collection).map(
    (k) => page.recordMap.collection[k]
  )[0];

  const collectionView: {
    value: { id: CollectionType["value"]["id"] };
  } = Object.keys(page.recordMap.collection_view).map(
    (k) => page.recordMap.collection_view[k]
  )[0];

  const pageBlock = page.recordMap.block[pageId!];
  const spaceId = pageBlock?.value?.space_id;
  const siteId = pageBlock?.value?.format?.site_id;

  const { rows } = await getTableData(
    collection,
    collectionView.value.id,
    req.notionToken,
    false,
    spaceId,
    siteId
  );

  return createResponse(rows);
}
