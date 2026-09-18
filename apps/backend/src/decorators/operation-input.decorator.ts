import {
  BadRequestException,
  createParamDecorator,
  type ExecutionContext,
} from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import type { ZodType } from 'zod';

import { getOperation, OPERATION_ID } from './operation.decorator';

/**
 * Request validation, read from the same manifest entry that wired the route.
 *
 * `@ValidatedBody()` takes no argument: it recovers the operation id from the
 * handler's own `@Operation(...)` metadata. That is the point — an operation id
 * written twice is an operation id that can be written inconsistently, and the
 * inconsistent case is "this handler validates against a different schema than
 * the one published in the OpenAPI document."
 *
 * Nest's class-validator DTOs describe a shape that must be kept in step with
 * the contract by hand. These decorators derive the shape FROM the contract, so
 * server validation, response serialisation, the spec and the generated client
 * are four views of one object rather than four things that agree today.
 */

function operationIdOf(context: ExecutionContext): string {
  const operationId = Reflect.getMetadata(
    OPERATION_ID,
    context.getHandler(),
  ) as string | undefined;

  if (!operationId) {
    // A programming error, not a request error: the handler is using contract
    // validation without declaring which contract. Failing loudly at the first
    // request beats validating against nothing.
    throw new Error(
      'ValidatedBody/ValidatedParams/ValidatedQuery requires the handler to carry @Operation(...).',
    );
  }
  return operationId;
}

function parse(
  schema: ZodType | undefined,
  value: unknown,
  where: string,
): unknown {
  if (!schema) {
    // The manifest declares no schema for this part of the request, so anything
    // supplied is undeclared input. Return nothing rather than the raw value:
    // undeclared input that reaches a handler is exactly how a mass-assignment
    // bug starts.
    return undefined;
  }

  const result = schema.safeParse(value);
  if (!result.success) {
    throw new BadRequestException({
      code: 'validation_failed',
      message: `Invalid ${where}.`,
      issues: result.error.issues.map((issue) => ({
        path: issue.path.join('.'),
        message: issue.message,
      })),
    });
  }
  return result.data;
}

export const ValidatedBody = createParamDecorator(
  (_data: unknown, context: ExecutionContext) => {
    const operation = getOperation(operationIdOf(context));
    const request = context.switchToHttp().getRequest<FastifyRequest>();
    return parse(operation.body, request.body, 'request body');
  },
);

export const ValidatedParams = createParamDecorator(
  (_data: unknown, context: ExecutionContext) => {
    const operation = getOperation(operationIdOf(context));
    const request = context.switchToHttp().getRequest<FastifyRequest>();
    return parse(operation.pathParams, request.params, 'path parameters');
  },
);

export const ValidatedQuery = createParamDecorator(
  (_data: unknown, context: ExecutionContext) => {
    const operation = getOperation(operationIdOf(context));
    const request = context.switchToHttp().getRequest<FastifyRequest>();
    return parse(operation.query, request.query, 'query parameters');
  },
);
