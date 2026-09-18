# subhub — 维护指南（Docker 自托管）

## 架构概览

`server/` 在构建镜像时把 `full.ini`/模板/外部规则固化到本地文件系统，运行时只读本地磁盘，零 GitHub 访问。只有 `PROXY_SUBS`/`RELAY_SUBS` 指向的真实订阅会在请求时联网拉取。

```
构建期（仅 vendor 阶段联网）
    full.ini → vendor-rules.mjs → vendor/gh/<path>（外部规则快照）

运行期（零网络，除订阅拉取）
    full.ini + rules/ + vendor/gh/ ──local-source.ts──→ 按 UA/target 分流生成配置
    PROXY_SUBS / RELAY_SUBS ──cache.ts（联网 + SUB_CACHE_TTL 刷新）──→ 节点列表
         失败 / 空正文 / 无节点 URI → 回退 CACHE_DIR 里上次成功的正文
```

## 文件职责

| 文件 | 职责 |
|---|---|
| `src/server.ts` | Node `http.createServer` 入口，从 `process.env` 组装 `Env` |
| `src/router.ts` | 路由 + UA 分流 + 鉴权 |
| `src/types.ts` | `Env` 接口 + 共享常量 |
| `src/memory-kv.ts` | 进程内 `Map` + 可选 JSON 落盘（`CACHE_DIR/kv.json`） |
| `src/local-source.ts` | 规则 URL → 本地文件路径，纯本地读取 |
| `src/cache.ts` | `PROXY_SUBS`/`RELAY_SUBS` 联网拉取；唯一允许运行时联网的模块 |
| `src/proxy.ts` | 解析代理 URI |
| `src/ini.ts` | 解析 `full.ini`；读本地文件 |
| `src/ruleset.ts` | `/ruleset/:index` 端点 |
| `src/shadowrocket.ts` / `src/surge.ts` / `src/sub.ts` / `src/clash.ts` | 各客户端配置生成 |
| `src/status.ts` | `/status`：规则集本地状态 |
| `scripts/vendor-rules.mjs` | **仅构建期**：下载非本仓库前缀的规则集到 `../vendor/gh/` |

## 订阅缓存

- 成功条件：HTTP 2xx **且**正文能解出至少一条代理 URI（明文或 base64）。空包、HTML、错误页不当作成功，不覆盖旧缓存。
- TTL 内直接返回磁盘/内存中的上次成功正文；TTL 到期或 `force=1` 才再拉。
- 拉取失败回退旧值。正文本身不过期。
- `CACHE_DIR`（默认 `/app/data/cache`）把 KV 写到 `kv.json`，容器重启后仍能回退。Compose 已挂 `subhub-cache` volume。
- `/status?key=KEY` 按订阅源序号显示最近一次拉取结果、HTTP 状态和是否有缓存；日志不输出订阅 URL 或 token。

## 规则 URL → 本地文件映射（`local-source.ts`）

1. `normalizeUrl()` 剥掉 `https://gh.monlor.com/` 代理前缀。
2. 若剥完后以 `https://raw.githubusercontent.com/monlor/subconverter-rules/main/` 开头 → 仓库内路径。
3. 否则 → `vendor/gh/<raw.githubusercontent.com 之后的路径>`。文件缺失返回 **502**，绝不回退网络。

## 更新外部规则快照

```bash
node server/scripts/vendor-rules.mjs   # 需要网络，写入 vendor/gh/
```

Docker 构建时会自动跑这一步。

## 端点列表

| 端点 | 鉴权 | 说明 |
|---|---|---|
| `GET /` | 无 | 帮助文本 |
| `GET /sub?key=K` | 需要 | SR 节点订阅（PROXY@/DIRECT@/RELAY@ 前缀 + chain 参数） |
| `GET /config?key=K` | 需要 | 按 UA 自动选客户端 |
| `GET /config?key=K&target=surge\|clash\|shadowrocket` | 需要 | 强制指定客户端 |
| `GET /ruleset/:index?t=shadowrocket\|surge` | 无 | 规则集（公开） |
| `GET /status?key=K` | 需要 | 规则文件本地状态 |

`&force=1` 跳过 TTL，强制再拉订阅；失败仍回退旧缓存。

## 本地开发

```bash
cd server
npm ci
npm run build
npm run vendor
PORT=3001 SECRET_KEY=test PROXY_SUBS=<订阅地址> node dist/server.js
npm test
```

## Docker

```bash
docker compose up -d --build
```

三阶段构建：`vendor` → `build` → `runtime`。订阅缓存目录 `/app/data` 应挂 volume，否则重启后丢失上次成功的订阅正文。
