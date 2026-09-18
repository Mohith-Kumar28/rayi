export interface PaginatedResult<T> {
  data: T[];
  metadata: {
    total: number;
    limit: number;
    offset: number;
    total_pages: number;
    has_next_page: boolean;
  };
}

export type PaginateOptions = {
  offset?: number;
  limit?: number;
};

export interface IPaginateFunction<K> {
  args?: K;
  options?: PaginateOptions;
}

export type PaginateFunction = <T, K>(
  model: any,
  args?: K,
  options?: PaginateOptions,
) => Promise<PaginatedResult<T>>;

export const paginator = (
  defaultOptions: PaginateOptions,
): PaginateFunction => {
  return async (model, args: any = { where: undefined }, options) => {
    // Explicit fallback: an undefined `take` means Prisma returns EVERY row,
    // which on a large table is an accidental full-table read.
    const limit = options?.limit ?? defaultOptions.limit ?? 10;
    const offset = options?.offset || defaultOptions.offset || 0;

    const [total, data] = await Promise.all([
      model.count({ where: args.where }),
      model.findMany({
        ...args,
        take: limit,
        skip: offset,
      }),
    ]);
    const total_pages = Math.ceil(total / limit);

    return {
      data,
      metadata: {
        total,
        limit: limit,
        offset: offset,
        total_pages: total_pages,
        has_next_page: offset + limit < total,
      },
    };
  };
};
