export type GatewayModelCatalogEntry = {
  id: string;
  upstreamModelId: string;
  label: string;
  isDefault: boolean;
  profileId: string;
  providerId: string;
  baseUrl: string;
  apiKey: string;
};

const DEFAULT_GATEWAY_MODEL_CATALOG = [
  {
    id: "gpt-5.2",
    upstreamModelId: "gpt-5.2",
    profileId: "aportal",
  },
  {
    id: "gpt-5.4",
    upstreamModelId: "gpt-5.4",
    profileId: "aportal",
  },
  {
    id: "gpt-4o",
    upstreamModelId: "gpt-4o",
    profileId: "aportal",
  },
  {
    id: "qwen35-plus",
    upstreamModelId: "qwen3.5-plus",
    profileId: "qwen",
  },
] as const;

function resolveDefaultGatewayModelId() {
  const configuredDefault =
    process.env.XLB_GATEWAY_MODEL?.trim() ||
    process.env.XLB_UPSTREAM_OPENAI_MODEL?.trim() ||
    "gpt-5.2";
  return isLegacyGatewayModelId(configuredDefault) ? "qwen35-plus" : configuredDefault;
}

export function isLegacyGatewayModelId(modelId?: string | null) {
  const normalized = modelId?.trim().toLowerCase();
  return normalized === "qwen35-plus" || normalized === "qwen3.5-plus";
}

export function normalizeGatewayModelId(modelId?: string | null) {
  const normalized = modelId?.trim();
  if (!normalized) {
    return resolveDefaultGatewayModelId();
  }

  if (isLegacyGatewayModelId(normalized)) {
    return "qwen35-plus";
  }

  return normalized;
}

function resolveModelProfileEnvPrefix(profileId: string) {
  const normalized =
    profileId
      ?.trim()
      .replace(/[^a-zA-Z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .toUpperCase() || "DEFAULT";
  return `XLB_GATEWAY_MODEL_PROFILE_${normalized}`;
}

function resolveGatewayProfile(profileId?: string | null) {
  const normalizedProfileId = profileId?.trim() || "default";
  const prefix = resolveModelProfileEnvPrefix(normalizedProfileId);
  const providerId =
    process.env[`${prefix}_PROVIDER_ID`]?.trim() ||
    process.env.XLB_GATEWAY_PROVIDER_ID?.trim() ||
    "openai";
  const baseUrl =
    process.env[`${prefix}_BASE_URL`]?.trim() ||
    process.env.XLB_UPSTREAM_OPENAI_BASE_URL?.trim() ||
    process.env.XLB_OPENAI_BASE_URL?.trim() ||
    process.env.OPENAI_BASE_URL?.trim() ||
    "https://api.aportal.ai/v1";
  const apiKey =
    process.env[`${prefix}_API_KEY`]?.trim() ||
    process.env.XLB_UPSTREAM_OPENAI_API_KEY?.trim() ||
    process.env.XLB_OPENAI_API_KEY?.trim() ||
    process.env.OPENAI_API_KEY?.trim() ||
    process.env.DASHSCOPE_API_KEY?.trim() ||
    "";

  return {
    id: normalizedProfileId,
    providerId,
    baseUrl,
    apiKey,
  };
}

export function resolveGatewayModelCatalog(): GatewayModelCatalogEntry[] {
  const rawCatalog = process.env.XLB_GATEWAY_MODEL_CATALOG?.trim() || "";
  const configuredDefault = resolveDefaultGatewayModelId();
  const fallbackUpstream = process.env.XLB_UPSTREAM_OPENAI_MODEL?.trim() || configuredDefault;
  const items: GatewayModelCatalogEntry[] = [];
  const seen = new Set<string>();

  const push = (id: string, upstreamModelId?: string | null, profileId?: string | null) => {
    const normalizedId = normalizeGatewayModelId(id);
    if (!normalizedId || seen.has(normalizedId)) {
      return;
    }

    const profile = resolveGatewayProfile(profileId);
    seen.add(normalizedId);
    items.push({
      id: normalizedId,
      upstreamModelId: upstreamModelId?.trim() || normalizedId,
      label: normalizedId,
      isDefault: normalizedId === configuredDefault,
      profileId: profile.id,
      providerId: profile.providerId,
      baseUrl: profile.baseUrl,
      apiKey: profile.apiKey,
    });
  };

  if (rawCatalog) {
    for (const chunk of rawCatalog.split(",")) {
      const entry = chunk.trim();
      if (!entry) {
        continue;
      }

      const [rawAliasPart, upstreamPart] = entry.includes("=") ? entry.split("=", 2) : [entry, entry];
      const upstreamWithProfile = upstreamPart.trim();
      const atIndex = upstreamWithProfile.lastIndexOf("@");
      const upstream =
        atIndex >= 0 ? upstreamWithProfile.slice(0, atIndex).trim() : upstreamWithProfile;
      const profileId =
        atIndex >= 0 ? upstreamWithProfile.slice(atIndex + 1).trim() : "default";
      const aliasPart = entry.includes("=") ? rawAliasPart : upstream;
      push(aliasPart, upstream, profileId);
    }
  }

  for (const item of DEFAULT_GATEWAY_MODEL_CATALOG) {
    push(item.id, item.upstreamModelId, item.profileId);
  }

  push(configuredDefault, fallbackUpstream, "default");

  if (!items.some((item) => item.isDefault) && items[0]) {
    items[0] = {
      ...items[0],
      isDefault: true,
    };
  }

  return items;
}

export function resolveConfiguredGatewayModel() {
  const catalog = resolveGatewayModelCatalog();
  return catalog.find((item) => item.isDefault)?.id || catalog[0]?.id || "gpt-5.2";
}

export function resolveManagedGatewayVisibleModelIds() {
  const catalogModelIds = Array.from(
    new Set(
      resolveGatewayModelCatalog()
        .map((item) => normalizeGatewayModelId(item.id))
        .filter(Boolean),
    ),
  );

  if (catalogModelIds.length > 0) {
    return catalogModelIds;
  }

  return [resolveConfiguredGatewayModel()];
}

function resolveManagedGatewaySupportModelIds() {
  const rawConfigured =
    process.env.XLB_GATEWAY_SUPPORT_MODELS?.trim() ??
    process.env.XLB_GATEWAY_EMBEDDING_MODEL?.trim() ??
    "text-embedding-3-small";

  if (!rawConfigured) {
    return [];
  }

  return Array.from(
    new Set(
      rawConfigured
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean),
    ),
  );
}

export function resolveManagedGatewayKeyModelIds() {
  return Array.from(
    new Set([
      ...resolveManagedGatewayVisibleModelIds(),
      ...resolveManagedGatewaySupportModelIds(),
    ]),
  );
}

export function resolveConfiguredProviderId(modelId?: string | null) {
  const normalizedModelId = normalizeGatewayModelId(modelId);
  const entry = resolveGatewayModelCatalog().find((item) => item.id === normalizedModelId);
  return entry?.providerId || resolveGatewayProfile("default").providerId;
}

export function resolveConfiguredOpenAiBaseUrl() {
  const configuredDefault = resolveConfiguredGatewayModel();
  const entry = resolveGatewayModelCatalog().find((item) => item.id === configuredDefault);
  return entry?.baseUrl || resolveGatewayProfile("default").baseUrl;
}

export function resolveConfiguredOpenAiApiKey(modelId?: string | null) {
  const normalizedModelId = normalizeGatewayModelId(modelId);
  const entry = resolveGatewayModelCatalog().find((item) => item.id === normalizedModelId);
  return entry?.apiKey || resolveGatewayProfile("default").apiKey;
}

function resolveGatewayModelGroupName(item: Pick<GatewayModelCatalogEntry, "profileId" | "providerId">) {
  const profileId = item.profileId?.trim().toLowerCase() || "";
  const providerId = item.providerId?.trim().toLowerCase() || "";

  if (profileId === "qwen" || profileId.includes("dashscope") || profileId.includes("qwen")) {
    return "Qwen";
  }
  if (profileId === "aportal") {
    return "OpenAI";
  }
  if (providerId === "openai") {
    return "OpenAI";
  }

  return profileId || providerId || "Other";
}

export function buildGatewayModelLabel(item: GatewayModelCatalogEntry) {
  const groupName = resolveGatewayModelGroupName(item);
  const modelName = item.id?.trim() || item.upstreamModelId?.trim() || "unnamed-model";
  return `${groupName} / ${modelName}`;
}
