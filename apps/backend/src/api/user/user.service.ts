import { BetterAuthService } from '@/auth/better-auth.service';
import { CursorPaginationDto } from '@/common/dto/cursor-pagination/cursor-pagination.dto';
import { CursorPaginatedDto } from '@/common/dto/cursor-pagination/paginated.dto';
import { OffsetPaginationDto } from '@/common/dto/offset-pagination/offset-pagination.dto';
import { OffsetPaginatedDto } from '@/common/dto/offset-pagination/paginated.dto';
import { Uuid } from '@/common/types/common.type';
import { PrismaService } from '@/database/prisma.service';
import { CurrentUserSession } from '@/decorators/auth/current-user-session.decorator';
import { I18nTranslations } from '@/generated/i18n.generated';
import { HttpStatus, Injectable, NotFoundException } from '@nestjs/common';
import { I18nService } from 'nestjs-i18n';
import { UpdateUserProfileDto } from './dto/update-user-profile.dto';
import {
  QueryUsersCursorDto,
  QueryUsersOffsetDto,
  UserDto,
} from './dto/user.dto';

@Injectable()
export class UserService {
  constructor(
    private readonly i18nService: I18nService<I18nTranslations>,
    private readonly prisma: PrismaService,
    private readonly betterAuthService: BetterAuthService,
  ) {}

  async findAllUsers(
    dto: QueryUsersOffsetDto,
  ): Promise<OffsetPaginatedDto<UserDto>> {
    const { limit = 10, page = 1 } = dto;
    const offset = (page - 1) * limit;

    const [users, total] = await Promise.all([
      this.prisma.user.findMany({
        where: { deletedAt: null },
        orderBy: { createdAt: 'desc' },
        take: limit,
        skip: offset,
      }),
      this.prisma.user.count({
        where: { deletedAt: null },
      }),
    ]);

    const paginationDto = new OffsetPaginationDto(total, dto);
    return new OffsetPaginatedDto(users as UserDto[], paginationDto);
  }

  async findAllUsersCursor(
    reqDto: QueryUsersCursorDto,
  ): Promise<CursorPaginatedDto<UserDto>> {
    const { limit = 10, afterCursor, beforeCursor } = reqDto;

    const whereCondition: any = { deletedAt: null };

    if (afterCursor) {
      whereCondition.createdAt = { lt: new Date(afterCursor) };
    } else if (beforeCursor) {
      whereCondition.createdAt = { gt: new Date(beforeCursor) };
    }

    const users = await this.prisma.user.findMany({
      where: whereCondition,
      orderBy: { createdAt: 'desc' },
      take: limit + 1, // Get one extra to check if there are more
    });

    const hasNext = users.length > limit;
    const hasPrevious = !!afterCursor;

    if (hasNext) {
      users.pop(); // Remove the extra user
    }

    const newAfterCursor =
      users.length > 0 ? users[users.length - 1].createdAt.toISOString() : null;
    const newBeforeCursor =
      users.length > 0 ? users[0].createdAt.toISOString() : null;

    const metaDto = new CursorPaginationDto(
      users.length,
      hasNext ? newAfterCursor : null,
      hasPrevious ? newBeforeCursor : null,
      reqDto,
    );

    return new CursorPaginatedDto(users as UserDto[], metaDto);
  }

  async findOneUser(
    id: Uuid | string,
    options?: { include?: any },
  ): Promise<UserDto> {
    const user = await this.prisma.user.findFirst({
      where: {
        id,
        deletedAt: null,
      },
      ...options,
    });

    if (!user) {
      throw new NotFoundException(this.i18nService.t('user.notFound'));
    }

    return user as UserDto;
  }

  async deleteUser(id: Uuid | string) {
    const user = await this.prisma.user.findFirst({
      where: { id, deletedAt: null },
    });

    if (!user) {
      throw new NotFoundException(this.i18nService.t('user.notFound'));
    }

    await this.prisma.user.update({
      where: { id },
      data: { deletedAt: new Date() },
    });

    return HttpStatus.OK;
  }

  async getAllUsers(options?: { include?: any; where?: any }) {
    return this.prisma.user.findMany({
      where: {
        deletedAt: null,
        ...options?.where,
      },
      ...options,
    });
  }

  async updateUserProfile(
    userId: string,
    dto: UpdateUserProfileDto,
    options: { headers: CurrentUserSession['headers'] },
  ) {
    let shouldChangeUsername = !(dto.username == null);

    if (shouldChangeUsername) {
      const user = await this.findOneUser(userId);
      shouldChangeUsername = user?.username !== dto.username;
    }

    await this.betterAuthService.api.updateUser({
      body: {
        ...(dto.image !== undefined ? { image: dto.image } : {}),
        ...(shouldChangeUsername ? { username: dto.username } : {}),
      },
      headers: options?.headers as any,
    });

    // Update rest of the fields manually
    await this.prisma.user.update({
      where: { id: userId },
      data: {
        firstName: dto.firstName,
        lastName: dto.lastName,
      },
    });

    return await this.findOneUser(userId);
  }
}
