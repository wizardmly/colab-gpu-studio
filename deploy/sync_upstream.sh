#!/usr/bin/env bash
# 无冲突同步上游主仓（TizenryA/colab-gpu-studio）到本 Fork 的 main 与 deploy 分支
# 兼容 GitHub 网页端 "Sync fork" 按钮与本地命令行，不重写远端历史，VPS 直接 git pull 即可升级
set -euo pipefail

UPSTREAM_URL="https://github.com/TizenryA/colab-gpu-studio.git"

if ! git remote get-url upstream >/dev/null 2>&1; then
  git remote add upstream "$UPSTREAM_URL"
fi

echo "==> [1/4] 拉取 origin 与上游 TizenryA/colab-gpu-studio 最新提交..."
git fetch origin --prune
git fetch upstream --prune

echo "==> [2/4] 快进更新 main 分支（保持与上游 main 100% 完全一致）..."
git checkout main
git merge --ff-only upstream/main
git push origin main

echo "==> [3/4] 同步 deploy 分支并合入最新 main..."
git checkout deploy
git merge --ff-only origin/deploy
git merge --no-edit main

echo "==> [4/4] 推送更新后的 deploy 分支到远端..."
git push origin deploy

echo "同步完成！在 VPS 上执行 'cd ~/colab-gpu-studio && git pull && sudo bash deploy/setup_vps_2g20g.sh' 即可平滑升级。"
