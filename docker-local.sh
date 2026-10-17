#!/usr/bin/env bash
# 本地一键起 ARTEX（Docker Compose）。
#
# 首次运行会自动从 docker.env.example 生成 .env 并填入随机 PostgreSQL 密码；
# 之后重复运行只会拉取镜像并重启服务，不会覆盖已有 .env。
set -euo pipefail
cd "$(dirname "$0")"

# 选一个可用的 compose 命令（新版插件 / 旧版独立二进制 / podman）。
if docker compose version >/dev/null 2>&1; then
  COMPOSE=(docker compose)
elif command -v docker-compose >/dev/null 2>&1; then
  COMPOSE=(docker-compose)
elif command -v podman-compose >/dev/null 2>&1; then
  COMPOSE=(podman-compose)
else
  echo "找不到 Docker Compose。请安装：docker compose 插件，或 docker-compose / podman-compose。" >&2
  exit 1
fi

if [ ! -f .env ]; then
  echo "[artex] 未发现 .env，正在从 docker.env.example 生成…"
  if ! command -v openssl >/dev/null 2>&1; then
    echo "需要 openssl 生成随机密码，或手动 cp docker.env.example .env 并填写 POSTGRES_PASSWORD。" >&2
    exit 1
  fi
  pw="$(openssl rand -hex 16)"
  # 只替换 POSTGRES_PASSWORD 那一行，保留模板其余内容。
  sed "s|^POSTGRES_PASSWORD=.*|POSTGRES_PASSWORD=${pw}|" docker.env.example > .env
  chmod 600 .env
  echo "[artex] 已生成 .env（密码随机，权限 600）。"
fi

# data/ 是容器内 /app/data 的绑定挂载点，必须存在且可写。
mkdir -p data

echo "[artex] 拉取镜像…"
"${COMPOSE[@]}" pull

echo "[artex] 启动…"
"${COMPOSE[@]}" up -d

echo
echo "[artex] 等待后端就绪…"
for _ in $(seq 1 60); do
  if curl -fsS --max-time 2 http://127.0.0.1:8787/api/health >/dev/null 2>&1; then
    echo "[artex] 就绪：http://localhost:8787"
    echo "[artex] 首次访问请在 /setup 设置管理员密码。"
    echo "[artex] LLM 密钥可在 UI 的「LLM 配置」页填写。"
    exit 0
  fi
  sleep 2
done

echo "[artex] 后端 120 秒内未就绪，查看日志：" >&2
echo "        ${COMPOSE[*]} logs --tail=80 artex" >&2
exit 1
