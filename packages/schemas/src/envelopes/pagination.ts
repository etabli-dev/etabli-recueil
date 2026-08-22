/**
 * Cursor pagination (CONCEPT.md §5.12, docs/api.qmd).
 *
 * Offsets lie when the underlying set changes under you, and a library is exactly the kind of set
 * that changes while you page through it — an ingestion run is inserting rows the whole time. So
 * records are paged by opaque cursor, and analytics is not paged at all: that is what the Parquet
 * export is for (ADR-0008).
 */
import * as z from 'zod';

export const DEFAULT_PAGE_SIZE = 25;
export const MAX_PAGE_SIZE = 200;

/**
 * An opaque continuation token. Clients must treat it as a blob: it encodes the sort key and the
 * last id, and its internals are free to change without a version bump.
 */
export const CursorSchema = z
  .string()
  .min(1)
  .max(2048)
  .regex(/^[A-Za-z0-9_-]+$/, 'must be a base64url continuation token')
  .meta({
    id: 'Cursor',
    title: 'Cursor',
    description: 'Opaque continuation token. Pass it back verbatim; never construct or parse one.',
  });

export const SortDirectionSchema = z.enum(['asc', 'desc']).meta({ id: 'SortDirection' });

/** The query parameters every record-listing endpoint accepts. */
export const PageParamsSchema = z
  .strictObject({
    cursor: CursorSchema.optional(),
    limit: z
      .number()
      .int()
      .min(1)
      .max(MAX_PAGE_SIZE)
      .optional()
      .meta({ description: `Page size, 1 to ${MAX_PAGE_SIZE}. Defaults to ${DEFAULT_PAGE_SIZE}.` }),
    order: SortDirectionSchema.optional(),
    sort: z
      .string()
      .max(64)
      .optional()
      .meta({ description: 'Sort field. The set of accepted fields is per endpoint.' }),
  })
  .meta({ id: 'PageParams', title: 'PageParams', unusedIO: 'input' });

/** The pagination block on every page response. */
export const PageInfoSchema = z
  .strictObject({
    nextCursor: CursorSchema.nullable().meta({ description: 'Null on the last page. Its absence is the end condition.' }),
    hasMore: z.boolean(),
    limit: z.number().int().min(1).max(MAX_PAGE_SIZE),
    total: z
      .number()
      .int()
      .min(0)
      .optional()
      .meta({
        description:
          'Total matching records, when the endpoint can count them cheaply. Absent is not zero: ' +
          'an endpoint that cannot count without a table scan omits it rather than lying.',
      }),
  })
  .meta({ id: 'PageInfo', title: 'PageInfo' });

/**
 * A page of records. A factory rather than a generic component, because OpenAPI 3.1 has no
 * generics: each concrete page is its own schema, named `<Thing>Page`.
 */
export const pageOf = <TSchema extends z.ZodType>(
  schema: TSchema,
  options: { id?: string; description?: string } = {},
) =>
  z.strictObject({ data: z.array(schema), page: PageInfoSchema }).meta({
    ...(options.id === undefined ? {} : { id: options.id, title: options.id }),
    ...(options.description === undefined ? {} : { description: options.description }),
  });

export type Cursor = z.infer<typeof CursorSchema>;
export type PageParams = z.infer<typeof PageParamsSchema>;
export type PageInfo = z.infer<typeof PageInfoSchema>;
export type Page<TValue> = { data: TValue[]; page: PageInfo };
