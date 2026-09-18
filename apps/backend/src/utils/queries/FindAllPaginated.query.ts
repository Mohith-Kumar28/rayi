import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsNumber, IsOptional } from 'class-validator';

export interface IFindAllPaginated {
  limit?: number;
  offset?: number;
}

export class FindAllPaginated implements IFindAllPaginated {
  @IsNumber()
  @IsOptional()
  @Type(() => Number)
  @ApiProperty({
    example: 10,
    default: 10,
    required: false,
  })
  limit?: number = 10;

  @IsNumber()
  @IsOptional()
  @Type(() => Number)
  @ApiProperty({
    example: 0,
    default: 0,
    required: false,
  })
  offset?: number = 0;
}
