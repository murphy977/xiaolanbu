import { IsIn } from "class-validator";

export class UpdateDeploymentStatusDto {
  @IsIn(["creating", "running", "stopped", "error"])
  status!: "creating" | "running" | "stopped" | "error";
}
