import { GlobalConfig } from '@/config/config.type';
import { FileInterceptor, FilesInterceptor } from '@nest-lab/fastify-multer';
import {
  CallHandler,
  ExecutionContext,
  Inject,
  Injectable,
  mixin,
  NestInterceptor,
  Type,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { diskStorage } from 'fastify-multer';
import fs from 'fs';
import mimeTypes from 'mime-types';
import path from 'path';
import { v4 as uuid } from 'uuid';

const UPLOAD_DESTINATION = path.join(
  __dirname,
  '..',
  '..',
  process.env.NODE_ENV === 'production' ? 'dist' : 'src',
  'tmp/file-uploads',
);

type FileInterceptorParameters = Parameters<typeof FileInterceptor>;

function FileUploadInterceptor(
  field: FileInterceptorParameters[0],
  options?: FileInterceptorParameters[1] & {
    multiple?: boolean;
    maxCount?: number;
  },
): Type<NestInterceptor> {
  @Injectable()
  class MixinInterceptor implements NestInterceptor {
    private readonly delegate: NestInterceptor;

    constructor(
      @Inject(ConfigService)
      private readonly configService: ConfigService<GlobalConfig>,
    ) {
      const isLocal = this.configService.get('app.localFileUpload', {
        infer: true,
      });

      const appliedOptions: FileInterceptorParameters[1] = {
        limits: { fileSize: 10e6, ...(options?.limits ?? {}) },
        ...(isLocal
          ? {
              storage: diskStorage({
                destination: function (_, _2, cb) {
                  if (!fs.existsSync(UPLOAD_DESTINATION)) {
                    fs.mkdirSync(UPLOAD_DESTINATION, { recursive: true });
                  }
                  cb(null, UPLOAD_DESTINATION);
                },
                filename: function (_, file, cb) {
                  cb(null, `${uuid()}.${mimeTypes.extension(file.mimetype)}`);
                },
              }),
            }
          : {}),
        ...((options as any) ?? {}),
      };

      const InterceptorClass = options?.multiple
        ? FilesInterceptor(field, options?.maxCount ?? 10, appliedOptions)
        : FileInterceptor(field, appliedOptions);

      this.delegate = new InterceptorClass(this.configService);
    }

    intercept(context: ExecutionContext, next: CallHandler) {
      return this.delegate.intercept(context, next);
    }
  }

  return mixin(MixinInterceptor);
}

export default FileUploadInterceptor;
