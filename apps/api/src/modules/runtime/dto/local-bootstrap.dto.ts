import { IsIn, IsOptional, IsString } from "class-validator";

export class LocalRuntimeBootstrapDto {
  @IsOptional()
  @IsString()
  accountScopeId?: string;

  @IsOptional()
  @IsIn(["darwin", "win32"])
  platform?: "darwin" | "win32";

  @IsOptional()
  @IsString()
  localDeviceId?: string;

  @IsOptional()
  @IsString()
  localDeviceLabel?: string;
}
