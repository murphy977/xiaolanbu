import {
  Body,
  Controller,
  Get,
  Head,
  Headers,
  Param,
  Post,
  Query,
  Res,
  StreamableFile,
  UnauthorizedException,
} from "@nestjs/common";

import { StoreService } from "../store/store.service";
import { LocalRuntimeBootstrapDto } from "./dto/local-bootstrap.dto";
import { RuntimeService } from "./runtime.service";

@Controller("runtime")
export class RuntimeController {
  constructor(
    private readonly runtimeService: RuntimeService,
    private readonly storeService: StoreService,
  ) {}

  private async requireUser(sessionToken?: string) {
    const user = await this.storeService.getUserBySessionTokenAsync(sessionToken);
    if (!user) {
      throw new UnauthorizedException("请先登录");
    }
    return user;
  }

  @Get("manifest")
  getManifest(@Query("platform") platform?: string, @Res({ passthrough: true }) response?: any) {
    const headers = this.runtimeService.getManifestHeaders();
    response?.setHeader("ETag", headers.etag);
    response?.setHeader("Last-Modified", headers.lastModified);
    response?.setHeader("Cache-Control", headers.cacheControl);
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
    response.setHeader("ETag", artifact.etag);
    response.setHeader("Last-Modified", artifact.lastModified);
    response.setHeader("Cache-Control", artifact.cacheControl);

    return new StreamableFile(artifact.stream);
  }

  @Head("download/:filename")
  headRuntime(@Param("filename") filename: string, @Res({ passthrough: true }) response: any) {
    const artifact = this.runtimeService.getDownloadStream(filename);
    response.setHeader("Content-Type", "application/gzip");
    response.setHeader("Content-Length", String(artifact.sizeBytes));
    response.setHeader("ETag", artifact.etag);
    response.setHeader("Last-Modified", artifact.lastModified);
    response.setHeader("Cache-Control", artifact.cacheControl);
    response.status(200).send();
  }

  @Post("local/bootstrap")
  async bootstrapLocalRuntime(
    @Body() body: LocalRuntimeBootstrapDto,
    @Headers("x-xlb-session") sessionToken?: string,
  ) {
    const currentUser = await this.requireUser(sessionToken);
    return this.runtimeService.bootstrapLocalCredential({
      userId: currentUser.id,
      accountScopeId: body.accountScopeId,
      platform: body.platform,
      localDeviceId: body.localDeviceId,
      localDeviceLabel: body.localDeviceLabel,
    });
  }
}
