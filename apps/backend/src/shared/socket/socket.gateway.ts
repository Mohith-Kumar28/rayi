import { AuthGuard } from '@/auth/auth.guard';
import { BetterAuthService } from '@/auth/better-auth.service';
import { getConfig as getAppConfig } from '@/config/app/app.config';
import { CurrentUserSession } from '@/decorators/auth/current-user-session.decorator';
import { Logger, UnauthorizedException, UseGuards } from '@nestjs/common';
import {
  ConnectedSocket,
  MessageBody,
  OnGatewayConnection,
  OnGatewayDisconnect,
  OnGatewayInit,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import { fromNodeHeaders } from 'better-auth/node';
import 'dotenv/config';
import ms from 'ms';
import { Server, Socket } from 'socket.io';
import { CacheService } from '../cache/cache.service';

const appConfig = getAppConfig();

type SocketWithUserSession = Socket & { session: CurrentUserSession };

@WebSocketGateway(0, {
  cors: {
    origin: appConfig.corsOrigin,
    methods: 'GET,HEAD,PUT,PATCH,POST,DELETE,OPTIONS',
    allowedHeaders: 'Content-Type, Accept,Authorization,X-Requested-With',
    credentials: true,
  },
})
export class SocketGateway
  implements OnGatewayInit, OnGatewayConnection, OnGatewayDisconnect
{
  readonly logger = new Logger(this.constructor.name);

  @WebSocketServer()
  private server: Server;

  private readonly clients: Map<string, Socket>;

  constructor(
    private readonly cacheService: CacheService,
    private readonly betterAuthService: BetterAuthService,
  ) {
    this.clients = new Map();
  }

  afterInit(): void {
    this.logger.log(`Websocket gateway initialized.`);
    this.server.use(async (socket: Socket, next) => {
      try {
        const session = await this.betterAuthService.api.getSession({
          headers: fromNodeHeaders(socket?.handshake?.headers),
        });
        if (!session) {
          throw new Error();
        }
        socket['session'] = session;
        return next();
      } catch {
        return next(
          new UnauthorizedException({
            code: 'UNAUTHORIZED',
          }),
        );
      }
    });
  }

  async handleConnection(socket: SocketWithUserSession) {
    // console.log('New client connected: ', socket?.id);
    const userId = socket?.session?.user?.id as string;
    if (!userId) {
      return;
    }
    this.clients.set(socket?.id, socket);
    const userClients = await this.cacheService.get<string[]>({
      key: 'UserSocketClients',
      args: [userId],
    });
    const clients = new Set<string>(Array.from(userClients ?? []));
    clients.add(socket?.id);
    await this.cacheService.set(
      { key: 'UserSocketClients', args: [userId] },
      Array.from(clients),
      { ttl: ms('1h') },
    );
  }

  async handleDisconnect(socket: SocketWithUserSession) {
    // console.log('Client disconnected: ', socket?.id);

    this.clients.delete(socket?.id);
    const userId = socket?.session?.user?.id as string;
    if (!userId) {
      return;
    }
    const userClients = await this.cacheService.get<string[]>({
      key: 'UserSocketClients',
      args: [userId],
    });
    const clients = new Set<string>(Array.from(userClients ?? []));
    if (clients.has(socket?.id)) {
      clients.delete(socket?.id);
      await this.cacheService.set(
        { key: 'UserSocketClients', args: [userId] },
        Array.from(clients),
        { ttl: ms('1h') },
      );
    }
  }

  @UseGuards(AuthGuard)
  @SubscribeMessage('message')
  handleMessage(
    @ConnectedSocket() socket: SocketWithUserSession,
    @MessageBody() _message: any,
    @CurrentUserSession('user') _user: CurrentUserSession['user'],
  ) {
    // console.log(
    //   `Received message from client: ${socket?.id}.`,
    //   JSON.stringify(_message, null, 2),
    //   _user,
    // );
    socket.send('hello world');
  }

  @SubscribeMessage('ping')
  async handlePing(socket: SocketWithUserSession) {
    socket.send('pong');
  }

  getClient(clientId: string): Socket | undefined {
    return this.clients?.get(clientId);
  }

  getAllClients() {
    return this.clients;
  }
}
