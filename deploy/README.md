# 2G20GB 海外 VPS + Google AI Ultra 专属部署与上游同步说明

本目录专为个人 Fork 仓库（`deploy` 分支）设计，所有定制编排与脚本均独立存放于 `deploy/` 下，避免污染主仓目录导致上游同步冲突。

---

## 一、如何永久避免与上游主仓（Sync Fork）冲突？

Fork 仓库出现冲突的根本原因是**直接在 `main` 分支上提交了个人修改**。本项目采用**双分支隔离法**：

1. **`main` 分支（纯净镜像分支）**：**永远不在 `main` 上直接提交任何代码**。这样你在 GitHub 网页上对 `main` 点击 **Sync fork -> Update branch** 时，永远是 100% 无冲突快进（Fast-forward）。
2. **`deploy` 分支（你的生产部署分支）**：包含 `deploy/` 目录下的 2G20GB 定制配置，以及 [`web/src/lib/gpu-api.ts`](../web/src/lib/gpu-api.ts) 中仅 4 行的弱网/上传超时优化。VPS 直接克隆并跟踪 `deploy` 分支。

### 日常同步上游新版本只需一行命令
当上游 `TizenryA/colab-gpu-studio` 发布新版本时，在你本地电脑执行：
```bash
bash deploy/sync_upstream.sh
```
然后 SSH 到你的 VPS 更新并重建：
```bash
cd ~/colab-gpu-studio
git fetch origin
git reset --hard origin/deploy
sudo bash deploy/setup_vps_2g20g.sh
```

---

## 二、2G 内存 + 20GB 硬盘 VPS + Gemini Ultra 首次部署步骤

### 0. Google AI Ultra（Gemini Ultra）前置一次性准备
在配置后台之前，请先用浏览器登录你的 Gemini Ultra 谷歌账号，打开一次 [Google Colab](https://colab.research.google.com/)，随便新建或打开一个笔记本点一下右上角连接，确认页面能看到你的 **Pro+ / Ultra 计算单元（通常每月 500 CU）** 已激活。
> Gemini Ultra 自带 **L4 / A100 优先分配权 + 后台长时运行 + 30TB Google Drive 空间**，开启 `GPU_STORAGE=drive` 后，模型权重缓存与所有生成的图片/有声视频都会自动校验备份进你的 30TB 网盘。

### 1. 在 VPS 上安装 Docker 与 Caddy，并拉取 `deploy` 分支
以 Ubuntu 22.04 / 24.04 为例（先将你的域名 `A` 记录解析到这台 VPS 的公网 IP）：
```bash
# 安装 Docker 与 Caddy
curl -fsSL https://get.docker.com | sh
sudo apt-get update && sudo apt-get install -y caddy git

# 克隆你的仓库并直接检出 deploy 分支
git clone -b deploy https://github.com/wizardmly/colab-gpu-studio.git ~/colab-gpu-studio
cd ~/colab-gpu-studio
```

### 2. 一键初始化环境、Swap、容器并自动清理构建垃圾
```bash
sudo bash deploy/setup_vps_2g20g.sh https://你的域名
```
该脚本针对 **2G 内存 / 20GB 硬盘** 做了五项关键保护：
1. 自动创建 **1.5GB Swap**（防止前端 Vite 编译与视频分块传输峰值触发 2G 内存 OOM）；
2. 自动生成 `.env` 并开启 `GPU_REAL_ENABLED=1`、`GPU_STORAGE=drive`、`GPU_REAL_RETENTION_VERIFIED=1`（解锁真实 L4/A100 的**保留/智能热复用**，连续出图出视频免重复拉取 20GB 权重）以及 `GPU_MAX_RUNTIME_MINUTES=60`（适配 MiniMax H3 视频精修耗时）；
3. 启用 `deploy/docker-compose.2g20g.yml`：限制容器日志最多占用 `90MB`，为 `worker` 分配 `640MB` 内存，并通过 `FORWARDED_ALLOW_IPS` 让后端精准识别反代后的真实访客 IP；
4. 启动 `api`、`worker`、`watchdog` 三个容器并等待健康检查通过；
5. 自动执行 `docker builder prune -af` 清空构建阶段残留的 ~1.2GB Node 缓存，为 20GB 硬盘留出约 **11GB+** 空间给作品缓存。

执行完后，查看并保存你的登录密码与主加密密钥（务必离线备份 `ENCRYPTION_KEY`）：
```bash
sudo grep -E '^(STUDIO_PASSWORD|ENCRYPTION_KEY|STUDIO_API_TOKEN)=' .env
```

### 3. 配置 Caddy 自动 HTTPS
参考 `deploy/Caddyfile.example` 写入 `/etc/caddy/Caddyfile`：
```bash
sudo tee /etc/caddy/Caddyfile >/dev/null <<'EOF'
你的域名 {
    encode zstd gzip
    request_body {
        max_size 110MB
    }
    reverse_proxy 127.0.0.1:8788
}
EOF
sudo systemctl reload caddy
```

### 4. 网页端绑定 Google OAuth 与启用工作流
1. 在 [Google Cloud Console](https://console.cloud.google.com/) 启用 **Google Drive API**，在 OAuth 同意屏幕添加 `https://www.googleapis.com/auth/colaboratory` 和 `https://www.googleapis.com/auth/drive.file` 两个 Scope（Testing 模式记得把你的 Ultra 邮箱加入 Test users）。
2. 创建 **Web 应用** OAuth 客户端：
   - 已获授权的 JavaScript 来源：`https://你的域名`
   - 已获授权的重定向 URI：`https://你的域名/api/gpu/auth/google/callback`
   - 下载客户端 JSON。
3. 手机或电脑打开 `https://你的域名` 登录 → **设置** → 导入客户端 JSON → 连接 **Google Colab** 与 **Google Drive** → 在 **算力** 页点「检查可用 GPU」确认能看到 `T4` / `L4` / `A100`。
4. 进入 **设置 › 工作流管理**，对 `krea2-moss-dual-t2i`（出图）和 `minimax-h3-i2v` / `minimax-h3-ref2v`（出视频）点击 **一键启用** 完成首次冒烟发布。
5. **20GB 硬盘日常维护提示**：所有生成的视频都会自动备份到你 30TB 的 Google Drive（`outputs/` 目录）中；当 VPS 本地硬盘占用超过 80% 时，直接在网页「作品」页批量删除旧视频即可释放 VPS 硬盘，Google Drive 里的永久备份不会被删。
