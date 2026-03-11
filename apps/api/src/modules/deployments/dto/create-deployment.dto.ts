import {
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Min,
  MinLength,
  ValidateNested,
} from "class-validator";
import { Type } from "class-transformer";

class DeploymentTagDto {
  @IsString()
  key!: string;

  @IsString()
  value!: string;
}

export class CreateDeploymentDto {
  @IsString()
  workspaceId!: string;

  @IsString()
  @MinLength(2)
  name!: string;

  @IsIn(["local", "cloud"])
  mode!: "local" | "cloud";

  @IsOptional()
  @IsString()
  region?: string;

  @IsOptional()
  @IsString()
  imageId?: string;

  @IsOptional()
  @IsString()
  instanceType?: string;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  instanceTypes?: string[];

  @IsOptional()
  @IsString()
  securityGroupId?: string;

  @IsOptional()
  @IsString()
  vSwitchId?: string;

  @IsOptional()
  @IsString()
  password?: string;

  @IsOptional()
  @IsString()
  userData?: string;

  @IsOptional()
  @IsString()
  openclawApiKey?: string;

  @IsOptional()
  @IsString()
  openclawProviderId?: string;

  @IsOptional()
  @IsString()
  openclawBaseUrl?: string;

  @IsOptional()
  @IsString()
  openclawModelId?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  openclawGatewayPort?: number;

  @IsOptional()
  @IsString()
  openclawGatewayBind?: string;

  @IsOptional()
  @IsString()
  systemDiskCategory?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(20)
  systemDiskSize?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  internetMaxBandwidthOut?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  amount?: number;

  @IsOptional()
  @Type(() => Boolean)
  @IsBoolean()
  dryRun?: boolean;

  @IsOptional()
  @Type(() => Boolean)
  @IsBoolean()
  waitForRunning?: boolean;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(10)
  waitTimeoutSeconds?: number;

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => DeploymentTagDto)
  tags?: DeploymentTagDto[];
}
