import { Type, applyDecorators } from '@nestjs/common';
import { ApiExtraModels, ApiOkResponse, getSchemaPath } from '@nestjs/swagger';

import { ApiProperty } from '@nestjs/swagger';

class ResponseMetadata {
  @ApiProperty()
  total?: number; // total of records

  @ApiProperty()
  limit?: number; // limit

  @ApiProperty()
  offset?: number; // offset

  @ApiProperty()
  total_pages?: number; // total of pages

  @ApiProperty()
  has_next_page?: boolean; // has next page
}

export class GetListResponse<T> {
  @ApiProperty()
  data: T[];

  @ApiProperty({
    type: ResponseMetadata,
  })
  metadata: ResponseMetadata;
}

export class GetOneResponse<T> {
  @ApiProperty()
  data: T;
}

export const ApiOkResponsePaginated = <DataDto extends Type<unknown>>(
  dataDto: DataDto,
) =>
  applyDecorators(
    ApiExtraModels(GetListResponse, dataDto),
    ApiOkResponse({
      schema: {
        allOf: [
          { $ref: getSchemaPath(GetListResponse) },
          {
            properties: {
              data: {
                type: 'array',
                items: { $ref: getSchemaPath(dataDto) },
              },
            },
          },
        ],
      },
    }),
  );
