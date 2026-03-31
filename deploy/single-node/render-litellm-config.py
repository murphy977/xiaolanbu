#!/usr/bin/env python3
import os


def resolve_profile_env_prefix(profile_id):
    normalized = "".join(
        char if char.isalnum() else "_" for char in (profile_id or "default").strip()
    ).strip("_")
    normalized = (normalized or "default").upper()
    return f"XLB_GATEWAY_MODEL_PROFILE_{normalized}"


def resolve_profile(profile_id):
    normalized = (profile_id or "default").strip() or "default"
    prefix = resolve_profile_env_prefix(normalized)
    provider_id = (
        (os.environ.get(f"{prefix}_PROVIDER_ID") or "").strip()
        or (os.environ.get("XLB_GATEWAY_PROVIDER_ID") or "").strip()
        or "openai"
    )
    base_url = (
        (os.environ.get(f"{prefix}_BASE_URL") or "").strip()
        or (os.environ.get("XLB_UPSTREAM_OPENAI_BASE_URL") or "").strip()
        or (os.environ.get("XLB_OPENAI_BASE_URL") or "").strip()
        or (os.environ.get("OPENAI_BASE_URL") or "").strip()
        or "https://api.aportal.ai/v1"
    )
    api_key_env = f"{prefix}_API_KEY" if (os.environ.get(f"{prefix}_API_KEY") or "").strip() else ""
    if not api_key_env:
        api_key_env = (
            "XLB_UPSTREAM_OPENAI_API_KEY"
            if (os.environ.get("XLB_UPSTREAM_OPENAI_API_KEY") or "").strip()
            else "XLB_OPENAI_API_KEY"
            if (os.environ.get("XLB_OPENAI_API_KEY") or "").strip()
            else "OPENAI_API_KEY"
            if (os.environ.get("OPENAI_API_KEY") or "").strip()
            else "DASHSCOPE_API_KEY"
            if (os.environ.get("DASHSCOPE_API_KEY") or "").strip()
            else ""
        )
    return {
        "id": normalized,
        "provider_id": provider_id,
        "base_url": base_url,
        "api_key_env": api_key_env,
    }


def parse_catalog():
    raw = (os.environ.get("XLB_GATEWAY_MODEL_CATALOG") or "").strip()
    default_alias = (
        (os.environ.get("XLB_GATEWAY_MODEL") or "").strip()
        or (os.environ.get("XLB_UPSTREAM_OPENAI_MODEL") or "").strip()
        or "gpt-5.2"
    )
    default_upstream = (os.environ.get("XLB_UPSTREAM_OPENAI_MODEL") or "").strip() or default_alias

    items = []
    seen = set()

    def add(alias, upstream, profile_id="default"):
        alias = (alias or "").strip()
        upstream = (upstream or "").strip()
        if not alias or alias in seen:
            return
        seen.add(alias)
        items.append(
            {
                "alias": alias,
                "upstream": upstream or alias,
                "profile": resolve_profile(profile_id),
            }
        )

    if raw:
        for chunk in raw.split(","):
            entry = chunk.strip()
            if not entry:
                continue
            if "=" in entry:
                alias, upstream_with_profile = entry.split("=", 1)
                alias = alias.strip()
            else:
                alias = entry
                upstream_with_profile = entry

            at_index = upstream_with_profile.rfind("@")
            if at_index >= 0:
                upstream = upstream_with_profile[:at_index].strip()
                profile_id = upstream_with_profile[at_index + 1 :].strip()
                if "=" not in entry:
                    alias = upstream
            else:
                upstream = upstream_with_profile.strip()
                profile_id = "default"
            add(alias, upstream, profile_id)

    add(default_alias, default_upstream, "default")
    support_profile_id = next(
        (item["profile"]["id"] for item in items if item["alias"] == default_alias),
        "default",
    )
    for support_model in parse_support_models():
        add(
            support_model["alias"],
            support_model["upstream"],
            support_model["profile_id"] or support_profile_id,
        )
    return items


def parse_support_models():
    raw = (
        (os.environ.get("XLB_GATEWAY_SUPPORT_MODELS") or "").strip()
        or (os.environ.get("XLB_GATEWAY_EMBEDDING_MODEL") or "").strip()
        or "text-embedding-v4@qwen"
    )
    if not raw:
        return []
    items = []
    seen = set()
    for chunk in raw.split(","):
        entry = chunk.strip()
        if not entry:
            continue
        if "=" in entry:
            alias, upstream_with_profile = entry.split("=", 1)
            alias = alias.strip()
        else:
            alias = entry
            upstream_with_profile = entry

        at_index = upstream_with_profile.rfind("@")
        if at_index >= 0:
            upstream = upstream_with_profile[:at_index].strip()
            profile_id = upstream_with_profile[at_index + 1 :].strip()
            if "=" not in entry:
                alias = upstream
        else:
            upstream = upstream_with_profile.strip()
            profile_id = ""

        normalized_alias = alias.strip()
        if not normalized_alias or normalized_alias in seen:
            continue
        seen.add(normalized_alias)
        items.append(
            {
                "alias": normalized_alias,
                "upstream": upstream or normalized_alias,
                "profile_id": profile_id,
            }
        )
    return items


def render():
    print("model_list:")
    for item in parse_catalog():
        provider_id = item["profile"]["provider_id"]
        model_prefix = provider_id if provider_id else "openai"
        print(f"  - model_name: {item['alias']}")
        print("    litellm_params:")
        print(f"      model: {model_prefix}/{item['upstream']}")
        print(f"      api_base: {item['profile']['base_url']}")
        api_key_env = item["profile"]["api_key_env"]
        if api_key_env:
            print(f"      api_key: os.environ/{api_key_env}")
    print("")
    print("general_settings:")
    print("  master_key: os.environ/LITELLM_MASTER_KEY")
    print("")
    print("litellm_settings:")
    print("  set_verbose: false")
    print("")
    print("router_settings:")
    print("  routing_strategy: simple-shuffle")


if __name__ == "__main__":
    render()
