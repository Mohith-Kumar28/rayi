import { ExecutionContext, Injectable } from '@nestjs/common';
import { ThrottlerGuard } from '@nestjs/throttler';
import { FastifyRequest } from 'fastify';

/**
 * Rate-limit tracker keyed on the client's address.
 *
 * The inherited implementation was:
 *
 *   const proxyIp = req.headers['x-forwarded-for'] ?? ... ;
 *   return (proxyIp ?? req?.ips?.length) ? req?.ips[0] : req?.ip;
 *
 * which had three defects, two of them security-relevant:
 *
 *  1. `??` short-circuits on a DEFINED value, so whenever a forwarded header was
 *     present the condition was truthy and the branch returned `ips[0]` —
 *     discarding the `proxyIp` it had just computed. The header parsing was dead
 *     code.
 *
 *  2. `ips[0]` is the LEFTMOST X-Forwarded-For entry, which is supplied by the
 *     client and can be anything. An attacker rotating that header gets a fresh
 *     rate-limit bucket per request, which defeats the limiter entirely. Only
 *     the entries appended by infrastructure you control are trustworthy, and
 *     those are at the RIGHT.
 *
 *  3. `req.ips` is optional, so `ips[0]` could throw on a request that arrived
 *     without any proxy headers.
 *
 * The correct source is `req.ip`. Fastify computes it from X-Forwarded-For
 * according to the `trustProxy` setting, honouring how many hops are actually
 * trusted — which is the decision that cannot be made safely by reading headers
 * directly here.
 *
 * NOTE: this is only sound if `trustProxy` is configured to the real number of
 * proxies in front of the app (CloudFront + ALB). Leave it unset and Fastify
 * ignores the header entirely, which is the safe default; set it too high and
 * client-supplied entries become trusted again.
 */
@Injectable()
export class AppThrottlerGuard extends ThrottlerGuard {
  getRequestResponse(context: ExecutionContext) {
    return super.getRequestResponse(context);
  }

  protected async getTracker(req: FastifyRequest): Promise<string> {
    return req.ip;
  }
}
