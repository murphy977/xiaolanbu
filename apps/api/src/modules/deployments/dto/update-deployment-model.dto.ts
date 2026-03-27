import { IsString, MinLength } from "class-validator";

export class UpdateDeploymentModelDto {
  @IsString()
  @MinLength(1)
  modelId!: string;
}
