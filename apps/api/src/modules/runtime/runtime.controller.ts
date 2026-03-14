import { Controller, Get, Param, Query, Res, StreamableFile } from "@nestjs/common";

import { RuntimeService } from "./runtime.service";

@Controller("runtime")
export class RuntimeController {
  constructor(private readonly runtimeService: RuntimeService) {}

  @Get("manifest")
  getManifest(@Query("platform") platform?: string) {
    return this.runtimeService.getManifest(platform);
  }

  @Get("download/:filename")
  downloadRuntime(@Param("filename") filename: string, @Res({ passthrough: true }) response: any) {
    const artifact = this.runtimeService.getDownloadStream(filename);
    response.setHeader("Content-Type", "application/gzip");
    response.setHeader("Content-Length", String(artifact.sizeBytes));
    response.setHeader(
      "Content-Disposition",
      `attachment; filename="${encodeURIComponent(filename)}"`,
    );

    return new StreamableFile(artifact.stream);
  }
}
