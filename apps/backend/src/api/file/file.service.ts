import { AwsS3Service } from '@/services/aws/aws-s3.service';
import { File } from '@nest-lab/fastify-multer';
import { Injectable } from '@nestjs/common';

@Injectable()
export class FileService {
  constructor(private readonly awsS3Service: AwsS3Service) {}

  async uploadFile(file: File) {
    if (file.destination) {
      return file;
    }
    return await this.awsS3Service.uploadFile(file, {
      filename: file.originalname,
    });
  }

  async uploadMultipleFiles(files: File[]) {
    if (files[0].destination) {
      return files;
    }
    return await Promise.all(
      files.map((file) =>
        this.awsS3Service.uploadFile(file, {
          filename: file.originalname,
        }),
      ),
    );
  }
}
