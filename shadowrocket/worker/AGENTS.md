# Shadowrocket Worker — 设计文档

## 项目目标

为 Shadowrocket 提供两个核心端点：

- `/sub` — SS 格式节点订阅（代理节点 + 中转节点合并，带前缀和 chain 参数）
- `/config` — Shadowrocket `.conf` 配置文件（路由规则 + 策略组，不含节点）

两者配合使用：在 Shadowrocket 中同时导入 `/config`（配置）和 `/sub`（订阅），配置负责规则，订阅负责节点。

---

## 节点命名规则

所有节点下载后，仅修改节点名称（加前缀），其余字段原样保留。

| 前缀 | 来源 | 说明 |
|---|---|---|
| `PROXY@` | `PROXY_SUBS` 中支持 proxy pass 的协议（如 vless、vmess、ss、trojan） | 走中转链路，URI 追加 `chain=🔀 中转代理` |
| `DIRECT@` | `PROXY_SUBS` 中不支持 proxy pass 的协议（tuic、hysteria2、hy2、anytls、wireguard 等） | 直接连接，无 chain |
| `RELAY@` | `RELAY_SUBS` | 中转节点，供中转策略组选择 |

**不支持 proxy pass 的协议（`PROXYPASS_UNSUPPORTED`）：**
```
wireguard, hysteria, hysteria2, hy2, tuic, juicity, anytls
```

---

## `/sub` 订阅生成逻辑

1. **无 UA 下载**：不设置 User-Agent，获取原始标准格式订阅（base64 编码 URI 列表）
2. **解码**：支持标准 base64 和 URL-safe base64，解码后按行分割
3. **命名**：
   - vmess：修改 JSON 中的 `ps` 字段
   - ssr：修改 base64 参数中的 `remarks` 字段
   - 其他：修改 URI 的 `#fragment` 或 `remark=` query param
4. **chain**：`PROXY@` 节点追加 `&chain=%F0%9F%94%80%20%E4%B8%AD%E8%BD%AC%E4%BB%A3%E7%90%86`（`🔀 中转代理`）
5. **输出**：全部节点合并，重新 base64 编码返回

**字段原则：除节点名外，所有参数原样透传，不做任何字段修改或增删。**

---

## `/config` 配置生成逻辑

1. **基础配置**：从 GitHub 拉取 `shadowrocket/full.conf`（含 General、DNS、Rule 等段），KV 缓存 30 天
2. **`[Proxy]` 段**：清空，节点由 `/sub` 订阅提供，不在 config 中内嵌
3. **`[Proxy Group]` 段**：在 full.conf 基础上 patch，不修改原始文件

### 策略组 patch 规则

对每一个含 `policy-regex-filter=` 的策略组行，按以下规则修改过滤器：

| 条件 | 处理 |
|---|---|
| `filter=.*` | 不变（手动选择、VoWiFi 等，可选所有节点） |
| filter 已含 `PROXY@`/`DIRECT@`/`RELAY@` | 不变（已处理过） |
| filter 含 `^(?!`（负向前瞻，自动选择/地区节点） | `^(?!` → `^PROXY@(?!`，只匹配 `PROXY@` 节点 |
| 其他关键词过滤（如游戏节点） | 改为 `^PROXY@.*(原filter)`，只匹配 `PROXY@` 节点 |

### worker 新增策略组

在 `[Proxy Group]` 首行插入：
```
🔀 中转代理 = select, 🇭🇰 香港中转, 🇹🇼 台湾中转, ..., DIRECT
```

末尾追加各地区中转 url-test 分组，过滤器格式：
```
^RELAY@(?!.*(排除关键词)).*(地区关键词).*$
```

### 策略组节点可见范围汇总

| 策略组类型 | 可见节点 |
|---|---|
| 自动选择（url-test，无地区） | 仅 `PROXY@` |
| 地区节点（url-test，香港/台湾/…） | 仅 `PROXY@` |
| 手动选择 | 全部（`.*`） |
| VoWiFi | 全部（`.*`） |
| 中转主组（🔀 中转代理） | 子组（各地区中转） + DIRECT |
| 地区中转（url-test，香港中转/…） | 仅 `RELAY@` |

---

## 缓存机制

- 所有订阅和基础配置通过 KV Namespace（绑定名 `CACHE`）缓存 30 天
- 成功拉取时写入 KV；拉取失败时回退到 KV 缓存（实现离线容灾）
- `?force=1` 参数跳过缓存强制刷新

---

## Secrets 配置

通过 `wrangler secret put` 配置：

| 变量 | 说明 |
|---|---|
| `SECRET_KEY` | URL 鉴权参数 `?key=` |
| `PROXY_SUBS` | 代理订阅 URL，逗号分隔，无 UA 下载 |
| `RELAY_SUBS` | 中转订阅 URL，逗号分隔，无 UA 下载 |

可选环境变量（`wrangler.toml [vars]`）：

| 变量 | 说明 |
|---|---|
| `BASE_CONFIG_URL` | 自定义基础 conf URL，默认用 GitHub 上的 `shadowrocket/full.conf` |

---

## Shadowrocket 使用方式

1. **导入配置**：设置 → 配置文件 → 从 `/config?key=xxx` 下载
2. **导入订阅**：首页 → 添加订阅 → `/sub?key=xxx`
3. **强制刷新**：在 URL 末尾加 `&force=1`
