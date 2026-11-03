## 全部规则

https://raw.githubusercontent.com/monlor/subconverter-rules/main/full.ini

* 支持美国和香港的esim规则
* 支持菲律宾，土耳其，马来西亚，德国，英国的各种电子钱包规则
* 支持Tiktok，Netflix等流媒体规则
* 支持ChatGPT规则

## Docker 自托管：subhub

`server/` 是 Node.js 自托管服务，项目名 **subhub**：构建镜像时把 `full.ini`、`rules/`、模板文件以及 `full.ini` 引用的全部外部规则（ACL4SSR 等）一起打包进镜像，容器运行时**零 GitHub 访问**，只联网拉取你自己的订阅地址（`PROXY_SUBS`/`RELAY_SUBS`）。

CI（`.github/workflows/docker-publish.yml`）在推送到 `main` 或打 tag 时自动构建并推送镜像到 `ghcr.io/monlor/subhub`。

### 使用方法

配置地址（Shadowrocket/Surge/Clash/Loon 客户端自动识别）：

```
http://<host>:3000/config?key=<SECRET_KEY>
```

强制指定客户端：

```
http://<host>:3000/config?key=<KEY>&target=surge
http://<host>:3000/config?key=<KEY>&target=clash
http://<host>:3000/config?key=<KEY>&target=loon
```

Shadowrocket 节点订阅（仅 SR 使用，含 PROXY@/DIRECT@/RELAY@ 链式代理）：

```
http://<host>:3000/sub?key=<KEY>
```

### 链式代理支持

| 客户端 | 机制 |
|---|---|
| Shadowrocket | 节点 URI `chain=🔀 中转代理` + RELAY@ 中转组 |
| Surge | 落地节点 `underlying-proxy=🔀 中转代理` |
| Clash/Mihomo | 落地节点 `dialer-proxy: 🔀 中转代理` |
| Loon | `[Proxy Chain]`：中转选择组 → 落地；按 Surge 的组结构组织 |

SS 订阅解析支持 SIP002 `plugin=obfs-local;...`（也接受 `simple-obfs`）和 Shadowrocket `obfs=http` / `obfs=tls` 搭配 `obfsParam=混淆域名` 参数，适用于用户信息 Base64 和旧式整段 Base64 链接。Surge、Loon、Clash 输出保留对应的混淆方式与域名；未配置混淆的节点不会自动添加混淆。

### Loon 使用说明

在 Loon 中导入上面的 `target=loon` 配置地址。沿用 `PROXY_SUBS`（落地）和 `RELAY_SUBS`（中转）；重新构建镜像后生效。

- `🔀 中转代理` 与 Surge 一样是手动选择组：可选 `🇭🇰 香港中转`、`🇸🇬 新加坡中转`、`🇺🇲 美国中转`、`🇯🇵 日本中转` 和 `DIRECT`；仅生成有合格节点的地区组。各地区使用 Loon 原生 `url-test` 自动测速（300 秒，切换容差 50ms），对应 Surge 的 `smart`。没有任何已识别地区时，直接在总选择组列出合格中转节点。
- Loon 的业务/地区组直接引用落地链名称，不生成冗余的 `代理节点`、`中转节点` 集合组；Surge 保留隐藏集合组供 `include-other-group` 使用。`🚀 手动选择`、`📶 VoWiFi` 同时提供落地链和原始中转节点，其他业务/地区组沿用 `full.ini`。
- 选择普通落地名称经过当前选定的中转地区；在 `🔀 中转代理` 里选择 `DIRECT` 时，全部落地跳过中转。直接选择中转原始节点则只使用该节点作为出口。取消 `DIRECT@落地` 等额外选项；`LANDING@` 节点仅用于链内部，不加入代理组。
- 控制落地链首跳的是 `🔀 中转代理`。当它选择某个地区时，由该地区的测速组选中转。未找到 Loon 官方文档支持与 Surge `hidden=true` 等价的隐藏参数，因此保留地区中转组的显示。
- `RELAY_SUBS` 默认排除名称含 `家宽`、`住宅`、`HOME` 的节点，仅保留标注 `1x`、`1X`、`1×` 或 `1.0x` 的受支持 TCP 节点（不会误选 `0.1x`、`11x`）；过滤条件仍可通过环境变量配置。
- 支持 SS、SSR、VMess、VLESS（含 Vision/Reality）、Trojan、Hysteria2、AnyTLS；跳过 TUIC、gRPC/XHTTP 等不支持的协议或传输。当前仅为 TCP 协议节点生成代理链；Hysteria2 可作为独立落地节点。
- 代理链采用 `udp=false`，不支持链式 UDP。Loon 文档只提供全局 `interface-mode`，没有找到与 Surge 组内蜂窝/网卡绑定等价的语法，因此不生成 `📱 蜂窝流量`、`↔️ 中转网卡` 和网卡节点。过滤后无可用中转时直接生成普通落地节点，并在配置中写入 `No eligible relay nodes` 注释。
- 使用 Loon 原生 `[Remote Rule]`：每个规则集单独列出，`policy` 绑定 `full.ini` 中原有代理组，`tag` 显示代理组及规则集名称。URL 指向本服务的 `/ruleset/N-name?t=loon`，仍从镜像内快照提供，不访问 GitHub。
- `[Rule]` 只保留 `FINAL`，其他规则（包括末尾的 `GEOIP,CN`）按 `full.ini` 顺序放到远程规则中，避免 Loon 本地规则高于远程规则的优先级改变匹配顺序。Loon 自身的域名/IP 分类匹配优先级仍然适用。

过滤条件通过环境变量设置，仅影响 Loon。两个表达式均不区分大小写，设置为空字符串可单独关闭对应过滤；非法表达式会在生成配置时报告变量名。

```sh
export LOON_RELAY_INCLUDE_REGEX='(^|[^0-9.])1([.]0)?[x×](?![0-9a-z.])'
export LOON_RELAY_EXCLUDE_REGEX='家宽|住宅|HOME'
docker compose up -d --build
```

中转覆盖范围与验证：SS、SSR、VMess、VLESS、Trojan、AnyTLS 落地会生成引用同一中转总选择的 TCP 链；Hysteria2 仍是独立节点，绕过中转；TUIC 及未支持的传输不会输出。没有合格中转时不会生成链。这与 Surge 在支持的落地节点上设置 `underlying-proxy` 的机制不同，不能保证全部协议具有相同行为。自动化测试验证生成引用及协议分支，不代表真实 Loon 已完成联网测试。验证中转应查看 Loon 请求记录的实际代理链及中转服务器连接记录，单看落地出口 IP 无法证明是否经过中转。

语法参考：[Loon 官方示例](https://github.com/Loon0x00/LoonExampleConfig/blob/master/example2.lcf)、[节点文档](https://nsloon.app/docs/Node/)，以及 [clash-nexus 的 Loon 转换器](https://github.com/d0zingcat/clash-nexus/blob/main/converter/loon/loon.go)中以策略组作为首跳的转换方式。自动化测试覆盖服务端生成，仍需在真实 Loon 客户端确认导入、测速和联网效果。

### 规则文件

`full.ini` 是所有规则组和策略组的唯一真源，本地自定义规则集放在 `rules/` 目录。

### 构建与运行

```bash
export SECRET_KEY='请替换为随机密钥'
export PROXY_SUBS='https://example.com/your-subscription'
# 可选：export RELAY_SUBS='https://example.com/your-relay-subscription'
docker compose up -d --build
# 或直接拉取预构建镜像
docker run -d --restart unless-stopped -p 3000:3000 \
  -v subhub-cache:/app/data \
  -e SECRET_KEY=<你的密钥> \
  -e PROXY_SUBS=<机场订阅地址，多个用换行或逗号分隔> \
  -e RELAY_SUBS=<中转订阅地址，可选> \
  ghcr.io/monlor/subhub:latest
```

必须挂载 `/app/data`。订阅拉取失败或返回空内容时，服务会回退到这个目录里上次成功的正文。

### 环境变量

| 变量 | 必填 | 说明 |
|---|---|---|
| `SECRET_KEY` | 否 | 鉴权密钥；不设置则 `/config`、`/sub`、`/status` 无需鉴权 |
| `PROXY_SUBS` | 是 | 落地代理订阅地址 |
| `RELAY_SUBS` | 否 | 中转代理订阅地址 |
| `LOON_RELAY_INCLUDE_REGEX` | 否 | Loon 中转名称保留正则，默认只保留 1x；空字符串关闭保留过滤 |
| `LOON_RELAY_EXCLUDE_REGEX` | 否 | Loon 中转名称排除正则，默认 `家宽\|住宅\|HOME`；空字符串关闭排除过滤 |
| `SURGE_INTERFACE` | 否 | Surge 出站接口名 |
| `PORT` | 否 | 监听端口，默认 `3000` |
| `SUB_CACHE_TTL` | 否 | 订阅刷新间隔（秒），默认 `3600`；`0` 表示每次请求都拉 |
| `CACHE_DIR` | 否 | 订阅缓存目录，默认 `/app/data/cache` |

使用 Compose 时，`SECRET_KEY` 和 `PROXY_SUBS` 必须显式设置。多个订阅地址可以用逗号或换行分隔。

订阅没有节点时，访问 `/status?key=<SECRET_KEY>` 查看每个订阅源的最近拉取结果、HTTP 状态和缓存回退状态；响应不会返回订阅 URL 或密钥。容器日志会记录同样的脱敏失败原因。

### 更新规则

规则内容在构建镜像时固化。改了 `full.ini`、`rules/*.ini` 或需要同步新的外部规则集后，重新构建镜像：

```bash
docker compose build --no-cache
docker compose up -d
```

详细架构说明见 `server/AGENTS.md`。
