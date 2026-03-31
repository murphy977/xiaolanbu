function asRecord(args) {
  return args && typeof args === "object" ? args : undefined;
}

export function normalizeToolName(name) {
  return String(name ?? "tool").trim() || "tool";
}

export function defaultTitle(name) {
  const cleaned = String(name ?? "")
    .replace(/_/g, " ")
    .trim();
  if (!cleaned) {
    return "Tool";
  }
  return cleaned
    .split(/\s+/)
    .map((part) =>
      part.length <= 2 && part.toUpperCase() === part
        ? part
        : `${part.at(0)?.toUpperCase() ?? ""}${part.slice(1)}`,
    )
    .join(" ");
}

function normalizeVerb(value) {
  const trimmed = value?.trim();
  if (!trimmed) {
    return undefined;
  }
  return trimmed.replace(/_/g, " ");
}

function resolveActionArg(args) {
  if (!args || typeof args !== "object") {
    return undefined;
  }
  const actionRaw = args.action;
  if (typeof actionRaw !== "string") {
    return undefined;
  }
  const action = actionRaw.trim();
  return action || undefined;
}

function coerceDisplayValue(
  value,
  {
    includeFalse = false,
    includeZero = false,
    includeNonFinite = false,
    maxStringChars = 160,
    maxArrayEntries = 3,
  } = {},
) {
  if (value === null || value === undefined) {
    return undefined;
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) {
      return undefined;
    }
    const firstLine = trimmed.split(/\r?\n/)[0]?.trim() ?? "";
    if (!firstLine) {
      return undefined;
    }
    if (firstLine.length > maxStringChars) {
      return `${firstLine.slice(0, Math.max(0, maxStringChars - 1))}…`;
    }
    return firstLine;
  }
  if (typeof value === "boolean") {
    if (!value && !includeFalse) {
      return undefined;
    }
    return value ? "true" : "false";
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      return includeNonFinite ? String(value) : undefined;
    }
    if (value === 0 && !includeZero) {
      return undefined;
    }
    return String(value);
  }
  if (Array.isArray(value)) {
    const values = value
      .map((item) =>
        coerceDisplayValue(item, {
          includeFalse,
          includeZero,
          includeNonFinite,
          maxStringChars,
          maxArrayEntries,
        }),
      )
      .filter(Boolean);
    if (values.length === 0) {
      return undefined;
    }
    const preview = values.slice(0, maxArrayEntries).join(", ");
    return values.length > maxArrayEntries ? `${preview}…` : preview;
  }
  return undefined;
}

function lookupValueByPath(args, path) {
  if (!args || typeof args !== "object") {
    return undefined;
  }
  let current = args;
  for (const segment of String(path).split(".")) {
    if (!segment || !current || typeof current !== "object") {
      return undefined;
    }
    current = current[segment];
  }
  return current;
}

function resolvePathArg(args) {
  const record = asRecord(args);
  if (!record) {
    return undefined;
  }
  for (const candidate of [record.path, record.file_path, record.filePath]) {
    if (typeof candidate !== "string") {
      continue;
    }
    const trimmed = candidate.trim();
    if (trimmed) {
      return trimmed;
    }
  }
  return undefined;
}

function resolveReadDetail(args) {
  const record = asRecord(args);
  if (!record) {
    return undefined;
  }

  const path = resolvePathArg(record);
  if (!path) {
    return undefined;
  }

  const offsetRaw =
    typeof record.offset === "number" && Number.isFinite(record.offset)
      ? Math.floor(record.offset)
      : undefined;
  const limitRaw =
    typeof record.limit === "number" && Number.isFinite(record.limit)
      ? Math.floor(record.limit)
      : undefined;

  const offset = offsetRaw !== undefined ? Math.max(1, offsetRaw) : undefined;
  const limit = limitRaw !== undefined ? Math.max(1, limitRaw) : undefined;

  if (offset !== undefined && limit !== undefined) {
    const unit = limit === 1 ? "line" : "lines";
    return `${unit} ${offset}-${offset + limit - 1} from ${path}`;
  }
  if (offset !== undefined) {
    return `from line ${offset} in ${path}`;
  }
  if (limit !== undefined) {
    const unit = limit === 1 ? "line" : "lines";
    return `first ${limit} ${unit} of ${path}`;
  }
  return `from ${path}`;
}

function resolveWriteDetail(toolKey, args) {
  const record = asRecord(args);
  if (!record) {
    return undefined;
  }

  const path =
    resolvePathArg(record) ?? (typeof record.url === "string" ? record.url.trim() : undefined);
  if (!path) {
    return undefined;
  }

  if (toolKey === "attach") {
    return `from ${path}`;
  }

  const destinationPrefix = toolKey === "edit" ? "in" : "to";
  const content =
    typeof record.content === "string"
      ? record.content
      : typeof record.newText === "string"
        ? record.newText
        : typeof record.new_string === "string"
          ? record.new_string
          : undefined;

  if (content && content.length > 0) {
    return `${destinationPrefix} ${path} (${content.length} chars)`;
  }

  return `${destinationPrefix} ${path}`;
}

function resolveWebSearchDetail(args) {
  const record = asRecord(args);
  if (!record) {
    return undefined;
  }
  const query = typeof record.query === "string" ? record.query.trim() : undefined;
  const count =
    typeof record.count === "number" && Number.isFinite(record.count) && record.count > 0
      ? Math.floor(record.count)
      : undefined;
  if (!query) {
    return undefined;
  }
  return count !== undefined ? `for "${query}" (top ${count})` : `for "${query}"`;
}

function resolveWebFetchDetail(args) {
  const record = asRecord(args);
  if (!record) {
    return undefined;
  }
  const url = typeof record.url === "string" ? record.url.trim() : undefined;
  if (!url) {
    return undefined;
  }
  const mode = typeof record.extractMode === "string" ? record.extractMode.trim() : undefined;
  const maxChars =
    typeof record.maxChars === "number" && Number.isFinite(record.maxChars) && record.maxChars > 0
      ? Math.floor(record.maxChars)
      : undefined;
  const suffix = [mode ? `mode ${mode}` : undefined, maxChars !== undefined ? `max ${maxChars} chars` : undefined]
    .filter(Boolean)
    .join(", ");
  return suffix ? `from ${url} (${suffix})` : `from ${url}`;
}

function compactCommand(raw, maxLength = 120) {
  const oneLine = String(raw)
    .replace(/\s*\n\s*/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim();
  if (oneLine.length <= maxLength) {
    return oneLine;
  }
  return `${oneLine.slice(0, Math.max(0, maxLength - 1))}…`;
}

function resolveExecDetail(args) {
  const record = asRecord(args);
  if (!record) {
    return undefined;
  }
  const raw = typeof record.command === "string" ? record.command.trim() : undefined;
  if (!raw) {
    return undefined;
  }
  const compact = compactCommand(raw);
  const cwd =
    typeof record.workdir === "string"
      ? record.workdir.trim()
      : typeof record.cwd === "string"
        ? record.cwd.trim()
        : undefined;
  return cwd ? `${compact} (in ${cwd})` : compact;
}

function resolveActionSpec(spec, action) {
  if (!spec || !action) {
    return undefined;
  }
  return spec.actions?.[action];
}

function resolveDetailFromKeys(args, keys, opts) {
  if (opts.mode === "first") {
    for (const key of keys) {
      const display = coerceDisplayValue(lookupValueByPath(args, key), opts.coerce);
      if (display) {
        return display;
      }
    }
    return undefined;
  }

  const entries = [];
  for (const key of keys) {
    const display = coerceDisplayValue(lookupValueByPath(args, key), opts.coerce);
    if (!display) {
      continue;
    }
    entries.push({
      label: opts.formatKey ? opts.formatKey(key) : key,
      value: display,
    });
  }
  if (entries.length === 0) {
    return undefined;
  }
  if (entries.length === 1) {
    return entries[0].value;
  }

  const seen = new Set();
  const unique = [];
  for (const entry of entries) {
    const token = `${entry.label}:${entry.value}`;
    if (seen.has(token)) {
      continue;
    }
    seen.add(token);
    unique.push(entry);
  }

  return unique
    .slice(0, opts.maxEntries ?? 8)
    .map((entry) => `${entry.label} ${entry.value}`)
    .join(" · ");
}

function resolveToolVerbAndDetail(params) {
  const actionSpec = resolveActionSpec(params.spec, params.action);
  const fallbackVerb =
    params.toolKey === "web_search"
      ? "search"
      : params.toolKey === "web_fetch"
        ? "fetch"
        : String(params.toolKey).replace(/_/g, " ").replace(/\./g, " ");
  const verb = normalizeVerb(actionSpec?.label ?? params.action ?? fallbackVerb);

  let detail;
  if (params.toolKey === "exec" || params.toolKey === "bash") {
    detail = resolveExecDetail(params.args);
  }
  if (!detail && params.toolKey === "read") {
    detail = resolveReadDetail(params.args);
  }
  if (!detail && ["write", "edit", "attach"].includes(params.toolKey)) {
    detail = resolveWriteDetail(params.toolKey, params.args);
  }
  if (!detail && params.toolKey === "web_search") {
    detail = resolveWebSearchDetail(params.args);
  }
  if (!detail && params.toolKey === "web_fetch") {
    detail = resolveWebFetchDetail(params.args);
  }

  const detailKeys =
    actionSpec?.detailKeys ?? params.spec?.detailKeys ?? params.fallbackDetailKeys ?? [];
  if (!detail && detailKeys.length > 0) {
    detail = resolveDetailFromKeys(params.args, detailKeys, {
      mode: params.detailMode,
      coerce: params.detailCoerce,
      maxEntries: params.detailMaxEntries,
      formatKey: params.detailFormatKey,
    });
  }
  if (!detail && params.meta) {
    detail = params.meta;
  }
  return { verb, detail };
}

export function resolveToolVerbAndDetailForArgs(params) {
  return resolveToolVerbAndDetail({
    toolKey: params.toolKey,
    args: params.args,
    meta: params.meta,
    action: resolveActionArg(params.args),
    spec: params.spec,
    fallbackDetailKeys: params.fallbackDetailKeys,
    detailMode: params.detailMode,
    detailCoerce: params.detailCoerce,
    detailMaxEntries: params.detailMaxEntries,
    detailFormatKey: params.detailFormatKey,
  });
}

export function formatToolDetailText(detail, opts = {}) {
  if (!detail) {
    return undefined;
  }
  const normalized = detail.includes(" · ")
    ? detail
        .split(" · ")
        .map((part) => part.trim())
        .filter(Boolean)
        .join(", ")
    : detail;
  if (!normalized) {
    return undefined;
  }
  return opts.prefixWithWith ? `with ${normalized}` : normalized;
}
