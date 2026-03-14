import { createReadStream, existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

import { Injectable, NotFoundException } from "@nestjs/common";

type RuntimePackageRecord = {
  platform: string;
  arch: string;
  openclawVersion: string;
  nodeVersion: string;
  filename: string;
  sizeBytes: number;
  sha256: string;
  generatedAt: string;
};

type RuntimeManifest = {
  generatedAt: string;
  packages: RuntimePackageRecord[];
};

@Injectable()
export class RuntimeService {
  private readonly runtimeDistDir =
    process.env.XLB_RUNTIME_DIST_DIR ?? path.resolve(process.cwd(), "../../runtime-dist");

  private readonly apiPublicBaseUrl =
    process.env.XLB_API_PUBLIC_BASE_URL ?? "http://127.0.0.1:3030/v1";

  getManifest(platform?: string) {
    const manifest = this.readManifest();
    const filteredPackages = platform
      ? manifest.packages.filter((item) => item.platform === platform)
      : manifest.packages;

    return {
      generatedAt: manifest.generatedAt,
      packages: filteredPackages.map((item) => ({
        ...item,
        downloadUrl: this.buildDownloadUrl(item.filename),
      })),
    };
  }

  getBootstrapPackagesForPlatform(platform: string) {
    const manifest = this.getManifest(platform);
    return manifest.packages.map((item) => ({
      arch: item.arch,
      downloadUrl: item.downloadUrl,
      sha256: item.sha256,
      filename: item.filename,
      openclawVersion: item.openclawVersion,
      nodeVersion: item.nodeVersion,
    }));
  }

  getDownloadStream(filename: string) {
    const filePath = path.join(this.runtimeDistDir, path.basename(filename));
    if (!existsSync(filePath)) {
      throw new NotFoundException(`Runtime package ${filename} not found.`);
    }

    return {
      stream: createReadStream(filePath),
      filePath,
      sizeBytes: statSync(filePath).size,
    };
  }

  private readManifest(): RuntimeManifest {
    const manifestPath = path.join(this.runtimeDistDir, "manifest.json");
    if (!existsSync(manifestPath)) {
      return {
        generatedAt: new Date(0).toISOString(),
        packages: [],
      };
    }

    const raw = JSON.parse(readFileSync(manifestPath, "utf8")) as RuntimeManifest;
    return {
      generatedAt: raw.generatedAt ?? new Date(0).toISOString(),
      packages: Array.isArray(raw.packages) ? raw.packages : [],
    };
  }

  private buildDownloadUrl(filename: string) {
    return `${this.apiPublicBaseUrl.replace(/\/$/, "")}/runtime/download/${encodeURIComponent(filename)}`;
  }
}
