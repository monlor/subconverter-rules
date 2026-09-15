## 全部规则

https://raw.githubusercontent.com/monlor/subconverter-rules/main/full.ini

* 支持美国和香港的esim规则
* 支持菲律宾，土耳其，马来西亚，德国，英国的各种电子钱包规则
* 支持Tiktok，Netflix等流媒体规则
* 支持ChatGPT规则

## 通用订阅转换服务 mysub.monlor.com

`worker/` 是部署在 `mysub.monlor.com` 的 Cloudflare Worker，运行时直接读取仓库 `full.ini` 生成三端配置，无需本地脚本。

### 使用方法

配置地址（Shadowrocket/Surge/Clash 客户端自动识别）：

```
https://mysub.monlor.com/config?key=<SECRET_KEY>
```

强制指定客户端：

```
https://mysub.monlor.com/config?key=<KEY>&target=surge
https://mysub.monlor.com/config?key=<KEY>&target=clash
```

Shadowrocket 节点订阅（仅 SR 使用，含 PROXY@/DIRECT@/RELAY@ 链式代理）：

```
https://mysub.monlor.com/sub?key=<KEY>
```

### 链式代理支持

| 客户端 | 机制 |
|---|---|
| Shadowrocket | 节点 URI `chain=🔀 中转代理` + RELAY@ 中转组 |
| Surge | `policy-path` + `external-policy-modifier=underlying-proxy=🔀 中转代理` |
| Clash/Mihomo | `proxy-providers` + `dialer-proxy: 🔀 中转代理` |

### 规则文件

`full.ini` 是所有规则组和策略组的唯一真源，本地自定义规则集放在 `rules/` 目录。

详细开发说明见 `AGENTS.md`。

## Docker 自托管：subhub

`server/` 是同一套逻辑的 Node.js 自托管版本，项目名 **subhub**：构建镜像时把
`full.ini`、`rules/`、模板文件以及 `full.ini` 引用的全部外部规则（ACL4SSR 等）一起打
包进镜像，容器运行时**零 GitHub 访问**，只联网拉取你自己的订阅地址
（`PROXY_SUBS`/`RELAY_SUBS`）。

CI（`.github/workflows/docker-publish.yml`）在推送到 `main` 或打 tag 时自动构建并推送
镜像到 `ghcr.io/monlor/subhub`。

### 构建与运行

```bash
export SECRET_KEY='请替换为随机密钥'
export PROXY_SUBS='https://example.com/your-subscription'
# 可选：export RELAY_SUBS='https://example.com/your-relay-subscription'
docker compose up -d --build
# 或直接拉取预构建镜像
docker run -d --restart unless-stopped -p 3000:3000 \
  -e SECRET_KEY=<你的密钥> \
  -e PROXY_SUBS=<机场订阅地址，多个用换行或逗号分隔> \
  -e RELAY_SUBS=<中转订阅地址，可选> \
  ghcr.io/monlor/subhub:latest
```

配置地址：`http://<host>:3000/config?key=<SECRET_KEY>`（用法同上方 Worker 版本）。

### 环境变量

| 变量 | 必填 | 说明 |
|---|---|---|
| `SECRET_KEY` | 否 | 鉴权密钥；不设置则 `/config`、`/sub`、`/status` 无需鉴权 |
| `PROXY_SUBS` | 是 | 落地代理订阅地址 |
| `RELAY_SUBS` | 否 | 中转代理订阅地址 |
| `SURGE_INTERFACE` | 否 | Surge 出站接口名 |
| `PORT` | 否 | 监听端口，默认 `3000` |

使用 Compose 时，`SECRET_KEY` 和 `PROXY_SUBS` 必须显式设置，避免以公开或空配置启动。
多个订阅地址可以使用逗号或换行分隔。

### 更新规则

规则内容在构建镜像时固化。改了 `full.ini`、`rules/*.ini` 或需要同步新的外部规则集
（如 ACL4SSR 上游更新）后，需要重新构建镜像：

```bash
docker compose build --no-cache
docker compose up -d
```

详细架构说明见 `server/AGENTS.md`。
