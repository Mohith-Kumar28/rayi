import {
  DEFAULT_CURRENT_PAGE,
  DEFAULT_PAGE_LIMIT,
} from '@/constants/app.constant';
import { ApiProperty } from '@nestjs/swagger';
import { Expose } from 'class-transformer';
import { PageOptionsDto } from './page-options.dto';

export class OffsetPaginationDto {
  @ApiProperty()
  @Expose()
  readonly limit: number;

  @ApiProperty()
  @Expose()
  readonly currentPage: number;

  @ApiProperty()
  @Expose()
  readonly nextPage?: number;

  @ApiProperty()
  @Expose()
  readonly previousPage?: number;

  @ApiProperty()
  @Expose()
  readonly totalRecords: number;

  @ApiProperty()
  @Expose()
  readonly totalPages: number;

  constructor(totalRecords: number, pageOptions: PageOptionsDto) {
    // Explicit defaults: `limit` and `page` are optional on PageOptionsDto, so
    // an absent limit previously produced `undefined > 0` (false) and
    // `totalRecords / undefined` (NaN).
    this.limit = pageOptions?.limit ?? DEFAULT_PAGE_LIMIT;
    this.currentPage = pageOptions?.page ?? DEFAULT_CURRENT_PAGE;
    this.totalRecords = totalRecords;

    // Assigned BEFORE nextPage/previousPage read it.
    //
    // The inherited order computed both against an as-yet-unassigned
    // `this.totalPages`, so `currentPage < undefined` was always false and
    // `nextPage` was always undefined — pagination silently never advertised a
    // next page. Field order in a constructor is load-bearing, and strict mode
    // did not catch this one; reading the code did.
    this.totalPages = this.limit > 0 ? Math.ceil(totalRecords / this.limit) : 0;

    this.nextPage =
      this.currentPage < this.totalPages ? this.currentPage + 1 : undefined;
    this.previousPage =
      this.currentPage > 1 && this.currentPage - 1 < this.totalPages
        ? this.currentPage - 1
        : undefined;
  }
}
