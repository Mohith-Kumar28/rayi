import { ErrorDto } from '@/common/dto/error.dto';
import { Serialize } from '@/utils/interceptors/serialize';
import {
  HttpCode,
  HttpStatus,
  type Type,
  applyDecorators,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiCreatedResponse,
  ApiOkResponse,
  ApiOperation,
  ApiOperationOptions,
  ApiResponse,
} from '@nestjs/swagger';
import { STATUS_CODES } from 'http';
import { Public } from './public.decorator';
import { ApiPaginatedResponse } from './swagger.decorators';

type ApiResponseType = number;
type PaginationType = 'offset' | 'cursor';

interface IApiOptions<T extends Type<any>> {
  type?: T;
  summary?: string;
  description?: string;
  errorResponses?: ApiResponseType[];
  statusCode?: HttpStatus;
  isPaginated?: boolean;
  paginationType?: PaginationType;
  operations?: ApiOperationOptions;
}

type IApiPublicOptions = IApiOptions<Type<any>>;
type IApiAuthOptions = IApiOptions<Type<any>>;

export const ApiPublic = (options: IApiPublicOptions = {}): MethodDecorator => {
  const defaultStatusCode = HttpStatus.OK;
  const defaultErrorResponses = [
    HttpStatus.BAD_REQUEST,
    HttpStatus.FORBIDDEN,
    HttpStatus.NOT_FOUND,
    HttpStatus.UNPROCESSABLE_ENTITY,
    HttpStatus.INTERNAL_SERVER_ERROR,
  ];
  const isPaginated = options.isPaginated || false;
  const ok = {
    type: options.type,
    description: options?.description ?? 'OK',
    paginationType: options.paginationType || 'offset',
  };

  const errorResponses = (options.errorResponses || defaultErrorResponses)?.map(
    (statusCode) =>
      ApiResponse({
        status: statusCode,
        type: ErrorDto,
        description: STATUS_CODES[statusCode],
      }),
  );

  const serializers = [];
  if (typeof options.type === 'function') {
    serializers.push(Serialize(options?.type));
  }

  return applyDecorators(
    Public(),
    ApiOperation({ summary: options?.summary, ...(options?.operations ?? {}) }),
    HttpCode(options.statusCode || defaultStatusCode),
    isPaginated ? ApiPaginatedResponse(ok) : ApiOkResponse(ok),
    ...serializers,
    ...errorResponses,
  );
};

export const ApiAuth = (options: IApiAuthOptions = {}): MethodDecorator => {
  const defaultStatusCode = HttpStatus.OK;
  const defaultErrorResponses = [
    HttpStatus.BAD_REQUEST,
    HttpStatus.UNAUTHORIZED,
    HttpStatus.FORBIDDEN,
    HttpStatus.NOT_FOUND,
    HttpStatus.UNPROCESSABLE_ENTITY,
    HttpStatus.INTERNAL_SERVER_ERROR,
  ];
  const isPaginated = options.isPaginated || false;
  const ok = {
    type: options.type,
    description: options?.description ?? 'OK',
    paginationType: options.paginationType || 'offset',
  };

  const errorResponses = (options.errorResponses || defaultErrorResponses)?.map(
    (statusCode) =>
      ApiResponse({
        status: statusCode,
        type: ErrorDto,
        description: STATUS_CODES[statusCode],
      }),
  );

  const serializers = [];
  if (typeof options.type === 'function') {
    serializers.push(Serialize(options?.type));
  }

  return applyDecorators(
    ApiOperation({ summary: options?.summary, ...(options?.operations ?? {}) }),
    HttpCode(options.statusCode || defaultStatusCode),
    isPaginated
      ? ApiPaginatedResponse(ok)
      : options.statusCode === 201
        ? ApiCreatedResponse(ok)
        : ApiOkResponse(ok),
    ApiBearerAuth(),
    ...serializers,
    ...errorResponses,
  );
};
