#!/usr/bin/env bash
# 针对 2GB RAM + 20GB SSD 海外 VPS（搭配 Google AI Ultra / Colab Pro）的一键初始化与升级脚本
# 用法：
#   首次部署：sudo bash deploy/setup_vps_2g20g.sh https://你的域名
#   后续升级：git pull && sudo bash deploy/setup_vps_2g20g.sh
set -euo pipefail

cd "$(dirname "$0")/.."
SITE_URL_ARG="${1:-}"

set_env_var() {
  local key="$1"
  local val="$2"
  if grep -qE "^${key}=" .env; then
    sed -i "s|^${key}=.*|${key}=${val}|" .env
  else
    printf '%s=%s\n' "$key" "$val" >> .env
  fi
}

echo "==> [1/5] 检查 2G 内存机器 Swap 保护（防止前端构建或视频传输突发 OOM）..."
if ! swapon --show | grep -q '/'; then
  if [ "$(id -u)" -eq 0 ] && [ ! -f /swapfile ]; then
    echo "    未检测到 Swap，正在创建 1.5GB /swapfile（兼顾 20GB 磁盘空间）..."
    fallocate -l 1536M /swapfile || dd if=/dev/zero of=/swapfile bs=1M count=1536 status=progress
    chmod 600 /swapfile
    mkswap /swapfile
    swapon /swapfile
    if ! grep -q '/swapfile' /etc/fstab; then
      echo '/swapfile none swap sw 0 0' >> /etc/fstab
    fi
    sysctl -w vm.swappiness=10 >/dev/null || true
    echo "    Swap 1.5GB 已启用。"
  else
    echo "    [提示] 当前无 Swap（若构建时报内存不足，请以 root 权限重跑本脚本自动创建 Swap）。"
  fi
else
  echo "    Swap 已存在，跳过。"
fi

echo "==> [2/5] 检查并准备 .env 配置文件..."
if [ ! -f .env ]; then
  if [ -z "$SITE_URL_ARG" ]; then
    echo "错误：首次初始化请传入你的 HTTPS 域名，例如：" >&2
    echo "  sudo bash deploy/setup_vps_2g20g.sh https://studio.example.com" >&2
    exit 1
  fi
  case "$SITE_URL_ARG" in
    https://*) ;;
    *)
      echo "错误：生产环境 Google OAuth 强制要求 SITE_URL 以 https:// 开头（当前：$SITE_URL_ARG）" >&2
      exit 1
      ;;
  esac

  docker run --rm -v "$PWD":/app -w /app python:3.12-slim \
    sh -c "pip install -q --no-cache-dir cryptography && python scripts/init_env.py --site-url '$SITE_URL_ARG'"

  # 针对真实 GPU（出图 + MiniMax H3 出视频 + Google AI Ultra 高额度/30TB Drive）写入生产参数
  set_env_var "ENVIRONMENT" "production"
  set_env_var "GPU_REAL_ENABLED" "1"
  set_env_var "GPU_STORAGE" "drive"
  set_env_var "GPU_REAL_RETENTION_VERIFIED" "1"
  set_env_var "GPU_PREFER_A100_FALLBACK" "1"
  set_env_var "GPU_MAX_RUNTIME_MINUTES" "60"
  set_env_var "GPU_UNIT_RATE" "0.027"
  set_env_var "GPU_DAILY_UNITS" "100"
  set_env_var "GPU_MONTHLY_UNITS" "2200"
  set_env_var "GPU_MAX_JOB_UNITS" "15"
  chmod 600 .env
  echo "    已生成并优化 .env（已开启 GPU_REAL_ENABLED=1, GPU_STORAGE=drive, 优先A100自动降级及 60 分钟视频超时上限）。"
  echo "    请使用以下命令查看初始网页登录密码并离线备份 ENCRYPTION_KEY："
  echo "      grep -E '^(STUDIO_PASSWORD|ENCRYPTION_KEY|STUDIO_API_TOKEN)=' .env"
else
  if ! grep -qE '^GPU_PREFER_A100_FALLBACK=' .env; then
    set_env_var "GPU_PREFER_A100_FALLBACK" "1"
    echo "    已为现有 .env 自动开启 GPU_PREFER_A100_FALLBACK=1（优先 A100，无卡自动切换 T4/L4）。"
  fi
  echo "    检测到已有 .env，保留现有密钥与配置不覆盖。"
fi

echo "==> [3/5] 准备 2G20GB 专用 docker-compose.yml..."
if [ ! -f docker-compose.yml ]; then
  cp deploy/docker-compose.2g20g.yml docker-compose.yml
  echo "    已从 deploy/docker-compose.2g20g.yml 生成本地 docker-compose.yml。"
else
  echo "    检测到已有 docker-compose.yml，保持不变（如需同步最新模板可执行 cp deploy/docker-compose.2g20g.yml docker-compose.yml）。"
fi

echo "==> [4/5] 构建并启动 api / worker / watchdog 容器..."
docker compose config -q
docker compose build
docker compose up -d --wait --wait-timeout 240
docker compose ps

echo "==> [5/5] 清理构建期 Node.js 缓存镜像，释放 20GB 硬盘空间..."
docker image prune -f >/dev/null 2>&1 || true
docker builder prune -af >/dev/null 2>&1 || true
df -h /

echo "部署完成！请将你的 HTTPS 域名反代至 127.0.0.1:8788。"
