import { Type } from "class-transformer";
import {
  IsBoolean,
  IsInt,
  IsOptional,
  IsString,
  Max,
  Min,
} from "class-validator";

export class SyncLocalRuntimeDto {
  @IsString()
  deviceId!: string;

  @IsOptional()
  @IsString()
  deviceLabel?: string;

  @IsOptional()
  @IsString()
  platform?: string;

  @IsOptional()
  @Type(() => Boolean)
  @IsBoolean()
  installed?: boolean;

  @IsOptional()
  @Type(() => Boolean)
  @IsBoolean()
  ready?: boolean;

  @IsOptional()
  @Type(() => Boolean)
  @IsBoolean()
  dashboardPortOpen?: boolean;

  @IsOptional()
  @Type(() => Boolean)
  @IsBoolean()
  browserControlPortOpen?: boolean;

  @IsOptional()
  @Type(() => Boolean)
  @IsBoolean()
  localApiKeyConfigured?: boolean;

  @IsOptional()
  @IsString()
  currentModelId?: string;

  @IsOptional()
  @IsString()
  ownerAccountScopeId?: string;

  @IsOptional()
  @IsString()
  ownerUserId?: string;

  @IsOptional()
  @IsString()
  ownerDisplayName?: string;

  @IsOptional()
  @IsString()
  ownerEmail?: string;

  @IsOptional()
  @IsString()
  workspaceId?: string;

  @IsOptional()
  @IsString()
  deploymentId?: string;

  @IsOptional()
  @IsString()
  authSyncedAt?: string;

  @IsOptional()
  @IsString()
  bindingUpdatedAt?: string;

  @IsOptional()
  @IsString()
  logPath?: string;

  @IsOptional()
  @IsString()
  bootstrapStage?: string;

  @IsOptional()
  @IsString()
  bootstrapMessage?: string;

  @IsOptional()
  @IsString()
  bootstrapLastLine?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(100)
  bootstrapProgressPercent?: number;

  @IsOptional()
  @IsString()
  error?: string;
}
