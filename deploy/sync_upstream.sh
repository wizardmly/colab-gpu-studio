#!/usr/bin/env bash
# 无冲突同步上游主仓（TizenryA/colab-gpu-studio）到本 Fork 的 main 与 deploy 分支
# 原理：
#   1. main 分支永远不提交任何个人代码，保持与上游 100% 快进同步（GitHub 网页点 Sync fork 永远零冲突）
#   2. 个人定制全部收敛在 deploy 分支（独立 deploy/ 目录 + 极小化前端超时优化），通过 rebase 线性叠加上游更新
set -euo pipefail

UPSTREAM_URL="https://github.com/TizenryA/colab-gpu-studio.git"

if ! git remote get-url upstream >/dev/null 2>&1; then
  git remote add upstream "$UPSTREAM_URL"
fi

echo "==> [1/4] 拉取上游 TizenryA/colab-gpu-studio 最新提交..."
git fetch upstream --prune

echo "==> [2/4] 快进更新本地与远端 main 分支（保持与主仓完全一致）..."
git checkout main
git merge --ff-only upstream/main
git push origin main

echo "==> [3/4] 将 deploy 分支变基（rebase）到最新 main 之上..."
git checkout deploy
git rebase main

echo "==> [4/4] 推送更新后的 deploy 分支到你的远端仓库..."
git push --force-with-lease origin deploy

echo "同步完成！VPS 上执行 'git fetch origin && git reset --hard origin/deploy && sudo bash deploy/setup_vps_2g20g.sh' 即可完成升级。"
