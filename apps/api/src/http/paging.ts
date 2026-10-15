import type { Context } from "hono";
import { z } from "zod";
import { PAGE_DEFAULT, PAGE_MAX, type PageParams, type PageResult } from "@weft/contracts";

const PageQuery = z.object({
  limit: z.coerce.number().int().min(1).max(PAGE_MAX).default(PAGE_DEFAULT),
  afterId: z.string().min(1).optional(),
  beforeId: z.string().min(1).optional(),
});

/** Cursor paging (SPEC 10): limit 1 to 100 (default 25), afterId, beforeId. Throws ZodError (400) when invalid. */
export function parsePage(c: Context): PageParams {
  const q = PageQuery.parse({ limit: c.req.query("limit"), afterId: c.req.query("afterId"), beforeId: c.req.query("beforeId") });
  return { limit: q.limit, afterId: q.afterId ?? null, beforeId: q.beforeId ?? null };
}

/** Fetch `limit + 1` rows, then call toPage: hasMore is true when the extra row exists. */
export function toPage<T>(rows: T[], limit: number): PageResult<T> {
  const data = rows.slice(0, limit);
  return { hasMore: rows.length > limit, count: data.length, data };
}
