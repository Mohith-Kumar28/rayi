import { StringFieldOptional } from '@/decorators/field.decorators';
import { Exclude, Expose } from 'class-transformer';

@Exclude()
export class UpdateUserProfileDto {
  @StringFieldOptional()
  @Expose()
  username: string;

  @StringFieldOptional({ nullable: true })
  @Expose()
  firstName: string;

  @StringFieldOptional({ nullable: true })
  @Expose()
  lastName: string;

  @StringFieldOptional({ nullable: true })
  @Expose()
  image: string;
}
