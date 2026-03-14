import { All, Controller, Logger, Req, Res } from "@nestjs/common";

import { LiteLlmProxyService } from "./services/litellm-proxy.service";

@Controller()
export class LiteLlmCompatController {
  private readonly logger = new Logger(LiteLlmCompatController.name);

  constructor(private readonly liteLlmProxyService: LiteLlmProxyService) {}

  @All("models")
  async proxyModels(@Req() req: any, @Res() res: any) {
    return this.forward(req, res, "models");
  }

  @All("chat/completions")
  async proxyChatCompletions(@Req() req: any, @Res() res: any) {
    return this.forward(req, res, "chat/completions");
  }

  private async forward(req: any, res: any, path: string) {
    this.logger.log(
      `proxy start path=${path} method=${req.method} contentLength=${req.headers?.["content-length"] ?? "unknown"}`,
    );
    const upstream = await this.liteLlmProxyService.proxyOpenAiRequest({
      path,
      method: req.method,
      headers: req.headers as Record<string, string | string[] | undefined>,
      body: req.body,
    });
    this.logger.log(
      `proxy response path=${path} status=${upstream.status} hasBody=${Boolean(upstream.body)}`,
    );

    for (const [key, value] of Object.entries(upstream.headers)) {
      if (
        key.toLowerCase() === "transfer-encoding" ||
        key.toLowerCase() === "content-length"
      ) {
        continue;
      }

      res.setHeader(key, value);
    }

    res.status(upstream.status);

    if (upstream.body) {
      upstream.body.pipe(res);
      return;
    }

    res.send(upstream.text ?? "");
  }
}
