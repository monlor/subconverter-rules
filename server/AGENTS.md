# subhub — 维护指南（Docker 自托管版）

## 架构概览

`server/` 是 `worker/` 的 Node.js 自托管移植版本。核心区别：`worker/` 运行时从 GitHub
拉取 `full.ini`/模板/外部规则并用 Cloudflare KV 缓存；`server/` 把这些内容全部在
**构建镜像时**固化到本地文件系统，运行时只读本地磁盘，零 GitHub 访问。只有
`PROXY_SUBS`/`RELAY_SUBS` 指向的真实订阅内容仍会在请求时联网拉取。

```
构建期（仅 vendor 阶段联网）
    full.ini → vendor-rules.mjs → vendor/gh/<path>（外部规则快照）

运行期（零网络，除订阅拉取）
    full.ini + rules/ + vendor/gh/ ──local-source.ts──→ 按 UA/target 分流生成配置
    PROXY_SUBS / RELAY_SUBS ──cache.ts（联网 + SUB_CACHE_TTL 刷新，失败用旧值）──→ 节点列表
```

## 文件职责

| 文件 | 职责 |
|---|---|
| `src/server.ts` | Node `http.createServer` 入口，`IncomingMessage`⇄`Request`/`Response` 转换，从 `process.env` 组装 `Env` |
| `src/router.ts` | 路由 + UA 分流 + 鉴权（对应 `worker/src/index.ts`） |
| `src/types.ts` | `Env` 接口（`process.env` 字段）+ 共享常量 |
| `src/memory-kv.ts` | 进程内 `Map` + TTL，替代 Cloudflare KV，实现 `get`/`put`/`list` 子集 |
| `src/local-source.ts` | **核心**：规则 URL → 本地文件路径的确定性映射，纯本地文件读取，不发起网络请求 |
| `src/cache.ts` | `PROXY_SUBS`/`RELAY_SUBS` 的联网拉取逻辑（`getSubContent`/`fetchSubLines`/`fetchUserinfo`），唯一允许运行时联网的模块 |
| `src/proxy.ts` | 解析代理 URI，从 `worker/src/proxy.ts` 原样复制 |
| `src/ini.ts` | 解析 `full.ini`；`fetchFullIni`/`fetchRepoFile` 改为读本地文件 |
| `src/ruleset.ts` | `/ruleset/:index` 端点，`handleRuleset` 改为读本地文件而非联网抓取 |
| `src/shadowrocket.ts` / `src/surge.ts` / `src/sub.ts` | 原样复制自 `worker/src` |
| `src/clash.ts` | rule-provider 的 `url` 从上游 GitHub 地址改为本服务自己的 `/ruleset/{idx}?t=shadowrocket`，确保 Mihomo 客户端本身也不直连 GitHub |
| `src/status.ts` | `/status` 端点：列出每条规则集的本地路径、来源（仓库内置/vendor 快照）、存在性、mtime，不做任何网络探测 |
| `scripts/vendor-rules.mjs` | **仅构建期运行**：解析根目录 `full.ini`，下载所有非本仓库前缀的规则集到 `../vendor/gh/<path>` |

## 规则 URL → 本地文件映射（`local-source.ts`）

不使用 manifest，纯路径约定：

1. `normalizeUrl()` 剥掉 `https://gh.monlor.com/` 代理前缀。
2. 若剥完前缀后的 URL 以 `https://raw.githubusercontent.com/monlor/subconverter-rules/main/`
   开头 → 直接映射为仓库内路径（如 `rules/ban.ini`），天然与仓库同步，无需 vendor。
3. 否则（外部规则，如 ACL4SSR）→ 映射为
   `vendor/gh/<raw.githubusercontent.com 之后的路径>`，例如
   `vendor/gh/ACL4SSR/ACL4SSR/master/Clash/BanAD.list`，必须由 `vendor-rules.mjs`
   预先下载。运行时若文件缺失，对应规则集请求返回 **502**，绝不回退到网络请求。

`full.ini` 本身不需要改写规则集 URL，`local-source.ts` 在读取时统一转换。

## 更新外部规则快照

```bash
node server/scripts/vendor-rules.mjs   # 需要网络，写入 vendor/gh/
```

Docker 构建时会自动跑这一步（`vendor` 构建阶段），本地增量更新可以直接跑脚本后重新
`docker build`。

## 端点列表

同 `worker/AGENTS.md`（`GET /config`、`GET /sub`、`GET /ruleset/:index?t=`、
`GET /status`），区别：

- `/status` 不再支持 `refresh=` 参数（没有可刷新的远程缓存），返回内容改为规则文件
  本地状态报告。
- `/ruleset/:index` 路径不带 `-{slug}` 后缀（简化，仍按数字前缀匹配）。

## 本地开发

```bash
cd server
npm ci
npm run build        # tsc -> dist/
npm run vendor        # 首次或规则更新后，联网抓取外部规则到 ../vendor/gh/
PORT=3001 SECRET_KEY=test PROXY_SUBS=<订阅地址> node dist/server.js
```

`PROXY_SUBS` 必须设置；多个订阅地址支持逗号或换行分隔。`SUB_CACHE_TTL`（秒，默认
3600）到期后下次请求再拉；`force=1` 立即刷新。正文不过期，拉取失败回退旧缓存。

运行回归测试：

```bash
npm test
```

## Docker

```bash
docker compose up -d --build
```

三阶段构建（见根目录 `Dockerfile`）：`vendor`（联网，抓取外部规则）→ `build`（`tsc`
编译）→ `runtime`（`node:alpine`，只拷贝编译产物 + `full.ini` + `rules/` +
`shadowrocket/` + `surge/` + `vendor/`，不含源码，无需网络即可启动）。可用
`docker run --network none ...` 验证：规则相关端点应正常工作，只有订阅拉取会失败。
