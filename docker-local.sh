#!/usr/bin/env bash
# 本地一键起 ARTEX（Docker Compose）。
#
#   ./docker-local.sh          首次运行生成 .env（随机 PostgreSQL 密码），拉镜像并启动
#   ./docker-local.sh logs     跟随后端日志
#   ./docker-local.sh down     停止并移除本项目容器（保留 data/ 与 pgdata 卷）
#   ./docker-local.sh status   查看 docker 守护进程与本项目容器状态
#
# Docker 守护进程是**按需启动**的（等价于 dockeron/dockeroff），不会开机自启，
# 本脚本也不会尝试启动它——启动守护进程需要 sudo，请自行执行 dockeron。
#
# 首次运行后打开 http://localhost:8787 ，在 /setup 设置管理员密码。
set -euo pipefail
cd "$(dirname "$0")"

say() { printf '[artex] %s\n' "$*"; }
die() { printf '[artex] %s\n' "$*" >&2; exit 1; }

# ---------------------------------------------------------------- compose 探测
if docker compose version >/dev/null 2>&1; then
  COMPOSE=(docker compose)
elif command -v docker-compose >/dev/null 2>&1; then
  COMPOSE=(docker-compose)
elif command -v podman-compose >/dev/null 2>&1; then
  COMPOSE=(podman-compose)
else
  die "找不到 Docker Compose。Arch/CachyOS: sudo pacman -S docker-compose docker-buildx"
fi

# ---------------------------------------------------------------- 前置检查
# 守护进程是按需启动的：连不上时只提示，绝不尝试自行启动（需要 sudo）。
require_daemon() {
  command -v docker >/dev/null 2>&1 || die "找不到 docker 命令。"
  docker info >/dev/null 2>&1 && return 0

  # 区分「没启动」和「没权限」：前者给 dockeron，后者给 usermod。
  if systemctl is-active --quiet docker.service 2>/dev/null; then
    die "Docker 守护进程在运行，但当前用户无权访问。
        sudo usermod -aG docker \$USER   # 然后注销并重新登录（组变更不作用于已有会话）"
  fi
  die "Docker 守护进程未启动（按需启动，不开机自启）。请先运行：

        dockeron        # = sudo systemctl start docker.socket docker.service

      然后重新执行本脚本。用完后记得 dockeroff 关闭守护进程。"
}

# 端口被占用时给出提示；若是本项目自己的容器则放行。
check_ports() {
  local busy="" p
  for p in 8787 8788; do
    if (exec 3<>"/dev/tcp/127.0.0.1/$p") 2>/dev/null; then
      busy="$busy $p"
    fi
  done
  [ -n "$busy" ] || return 0
  die "本机端口已被占用:$busy
        若是其他程序：先停掉它；若是本项目的旧容器：./docker-local.sh down"
}

# ---------------------------------------------------------------- .env
ensure_env() {
  if [ ! -f .env ]; then
    say "未发现 .env，正在从 docker.env.example 生成…"
    command -v openssl >/dev/null 2>&1 \
      || die "需要 openssl 生成随机密码；或手动 cp docker.env.example .env 并填写 POSTGRES_PASSWORD。"
    local pw
    pw="$(openssl rand -hex 16)"
    sed "s|^POSTGRES_PASSWORD=.*|POSTGRES_PASSWORD=${pw}|" docker.env.example > .env
    chmod 600 .env
    say "已生成 .env（密码随机，权限 600）。"
    return 0
  fi

  # .env 存在但密码为空时补一个：compose 会因 POSTGRES_PASSWORD 为空而拒绝启动。
  if grep -q '^POSTGRES_PASSWORD=[[:space:]]*$' .env; then
    command -v openssl >/dev/null 2>&1 || die ".env 中 POSTGRES_PASSWORD 为空，且找不到 openssl。"
    local pw
    pw="$(openssl rand -hex 16)"
    sed -i "s|^POSTGRES_PASSWORD=.*|POSTGRES_PASSWORD=${pw}|" .env
    say "已为现有 .env 补上随机 POSTGRES_PASSWORD。"
  fi
}

# ---------------------------------------------------------------- 健康等待
wait_healthy() {
  say "等待后端就绪…"
  local i
  for i in $(seq 1 60); do
    if command -v curl >/dev/null 2>&1; then
      curl -fsS --max-time 2 http://127.0.0.1:8787/api/health >/dev/null 2>&1 && return 0
    else
      "${COMPOSE[@]}" ps artex 2>/dev/null | grep -qi healthy && return 0
    fi
    sleep 2
  done
  return 1
}

# 停止守护进程会连带停掉容器，所以只在没有运行中容器时建议 dockeroff。
hint_dockeroff() {
  local n
  n="$("${COMPOSE[@]}" ps -q 2>/dev/null | wc -l)" || n=0
  if [ "${n:-0}" -eq 0 ]; then
    say "容器已全部停止。不需要 Docker 时可运行 dockeroff 关闭守护进程。"
  else
    say "仍有 $n 个本项目容器在运行；docker 守护进程保持开启。"
  fi
}

# ---------------------------------------------------------------- 主流程
case "${1:-up}" in
  up)
    require_daemon
    ensure_env
    mkdir -p data

    # 只在没有本项目容器运行时检查端口，避免重启自己的栈时误报。
    [ -n "$("${COMPOSE[@]}" ps -q 2>/dev/null || true)" ] || check_ports

    say "拉取镜像…"
    "${COMPOSE[@]}" pull || say "拉取失败，尝试使用本地已有镜像。"

    say "启动…"
    "${COMPOSE[@]}" up -d

    if wait_healthy; then
      say "就绪：http://localhost:8787"
      say "首次访问请在 /setup 设置管理员密码。"
      say "LLM 密钥可在 UI 的「LLM 配置」页填写。"
      say "日志：./docker-local.sh logs    停止：./docker-local.sh down"
      exit 0
    fi

    printf '[artex] 后端 120 秒内未就绪，最近日志：\n' >&2
    "${COMPOSE[@]}" logs --tail=80 artex >&2 || true
    exit 1
    ;;
  logs)
    require_daemon
    exec "${COMPOSE[@]}" logs -f --tail=100 artex
    ;;
  down)
    # 守护进程已停时 down 无从执行，但结果（容器不在运行）已经达成。
    if ! docker info >/dev/null 2>&1; then
      say "Docker 守护进程未运行，容器本就不在运行。"
      exit 0
    fi
    "${COMPOSE[@]}" down
    hint_dockeroff
    ;;
  status)
    echo "--- 守护进程 ---"
    systemctl is-active docker.service docker.socket containerd.service 2>/dev/null || true
    echo "--- 本项目容器 ---"
    if docker info >/dev/null 2>&1; then
      "${COMPOSE[@]}" ps 2>/dev/null || true
    else
      echo "(守护进程未运行)"
    fi
    ;;
  *)
    die "未知子命令 '$1'。可用：up（默认）、logs、down、status"
    ;;
esac
