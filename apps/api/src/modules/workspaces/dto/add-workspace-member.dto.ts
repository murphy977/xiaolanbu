import { IsEmail, IsIn, IsOptional } from "class-validator";

export class AddWorkspaceMemberDto {
  @IsEmail({}, { message: "请填写有效的邮箱地址" })
  email = "";

  @IsOptional()
  @IsIn(["owner", "member"], { message: "角色必须是 owner 或 member" })
  role?: "owner" | "member";
}
