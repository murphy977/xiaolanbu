import { IsIn } from "class-validator";

export class UpdateWorkspaceMemberDto {
  @IsIn(["owner", "member"], { message: "角色必须是 owner 或 member" })
  role: "owner" | "member" = "member";
}
