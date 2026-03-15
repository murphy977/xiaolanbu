# Xiaolanbu Single-Node Deployment

This directory contains the fastest MVP deployment layout for one Alibaba Cloud ECS.

## Target Host

- Region: `cn-hongkong`
- System: Alibaba Cloud Linux
- Spec: `4C8G`
- Public IP: `47.86.38.197`

## Services

- `api`: Xiaolanbu NestJS backend on internal port `3030`
- `kong`: dedicated LLM ingress on internal port `8000`
- `litellm`: centralized LLM gateway on internal port `4000`
- `postgres`: backing store for LiteLLM
- `caddy`: reverse proxy on port `80`

Routing:

- `http://47.86.38.197/api/*` -> `api:3030`
- `http://47.86.38.197/v1/*` -> `kong:8000` -> `litellm:4000`
- `http://47.86.38.197/key/*` -> `kong:8000` -> `litellm:4000`

Once you have your domain, replace the IP-based Caddy config with real hostnames:

- `api.xiaolanbu.app`
- `gateway.xiaolanbu.app`

## Alibaba Linux bootstrap

Run on the server:

```bash
sudo dnf update -y
sudo dnf install -y docker git
sudo systemctl enable --now docker
sudo usermod -aG docker $USER
newgrp docker
docker version
```

If `docker compose` is unavailable, install the compose plugin:

```bash
sudo mkdir -p /usr/local/lib/docker/cli-plugins
sudo curl -SL https://github.com/docker/compose/releases/download/v2.35.1/docker-compose-linux-x86_64 \
  -o /usr/local/lib/docker/cli-plugins/docker-compose
sudo chmod +x /usr/local/lib/docker/cli-plugins/docker-compose
docker compose version
```

## Deploy

Copy the repo to the server, then:

```bash
cd /path/to/xiaolanbu/deploy/single-node
cp .env.example .env
vi .env
docker compose build api
docker compose up -d
docker compose ps
```

## Required secrets in `.env`

- `ALIBABA_CLOUD_ACCESS_KEY_ID`
- `ALIBABA_CLOUD_ACCESS_KEY_SECRET`
- `DASHSCOPE_API_KEY`
- `LITELLM_MASTER_KEY`
- `POSTGRES_PASSWORD`

## Smoke tests

Backend:

```bash
curl http://47.86.38.197/api/v1/health
```

LiteLLM:

```bash
curl http://47.86.38.197/v1/models \
  -H "Authorization: Bearer ${LITELLM_MASTER_KEY}"
```

Kong path health:

```bash
curl http://47.86.38.197/key/info \
  -H "Authorization: Bearer ${LITELLM_MASTER_KEY}"
```

## Next step

After this is up, change the OpenClaw instance init flow to use:

- `base_url = http://47.86.38.197/v1`
- `api_key = your Xiaolanbu virtual key`

Do not write the real DashScope key into user instances.

## Restricted tunnel account

If you use the restricted `xlb-tunnel` account for local deployments, update its
`authorized_keys` rule to allow forwarding to Kong instead of the Nest API:

```text
permitopen="127.0.0.1:8000"
```
