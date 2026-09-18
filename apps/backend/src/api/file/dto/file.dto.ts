import { StringField } from '@/decorators/field.decorators';
import { Exclude, Expose } from 'class-transformer';

// Must be same as AwsS3UploadResponse
@Exclude()
export class FileDto {
  @StringField()
  @Expose()
  originalname: string;

  @StringField()
  @Expose()
  filename: string;

  @StringField()
  @Expose()
  mimetype: string;

  @StringField()
  @Expose()
  size: string;

  @StringField()
  @Expose()
  path: string;
}
