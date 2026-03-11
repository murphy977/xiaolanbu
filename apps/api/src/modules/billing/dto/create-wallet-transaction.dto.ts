import { IsNumber, IsOptional, IsString, Min } from "class-validator";

export class CreateWalletTopupDto {
  @IsNumber()
  @Min(0.000001)
  amountCny!: number;

  @IsOptional()
  @IsString()
  title?: string;
}

export class CreateWalletAdjustmentDto {
  @IsNumber()
  amountCny!: number;

  @IsOptional()
  @IsString()
  title?: string;
}
