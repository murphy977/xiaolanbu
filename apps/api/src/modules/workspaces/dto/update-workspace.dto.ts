import { IsString, MaxLength, MinLength } from "class-validator";

export class UpdateWorkspaceDto {
  @IsString()
  @MinLength(2, { message: "工作区名称至少需要 2 个字符" })
  @MaxLength(40, { message: "工作区名称请控制在 40 个字符以内" })
  name = "";
}
