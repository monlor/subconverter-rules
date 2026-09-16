# mysub Worker — 维护指南

## 架构概览

Worker 部署在 `mysub.monlor.com`，运行时从 GitHub 读取 `full.ini`，按需生成多客户端配置，无本地预生成文件。

```
full.ini（唯一真源）
    ├── parseRuleSets()   → RuleSet[]   → 规则段
    └── parseProxyGroups()→ ProxyGroup[]→ 策略组段

PROXY_SUBS / RELAY_SUBS（secrets）
    └── fetchSubLines()   → URI[]       → 节点列表

                ↓  按 UA 或 ?target= 分流
        ┌───────┬────────┬─────────┐
        SR      Surge    Clash     /sub
        │       │        │         │
  template.conf  template.conf  (无模板)  (URI 前缀化)
  [Proxy Group]  [Proxy Group]  proxies:
  [Rule]         [Rule]         proxy-groups:
  RELAY@ patch   underlying-proxy  dialer-proxy
```

---

## 文件职责

| 文件 | 职责 |
|---|---|
| `index.ts` | 路由 + UA 分流 + 鉴权，所有端点入口 |
| `types.ts` | `Env` 接口、常量（`PROXYPASS_UNSUPPORTED`、`EXCLUDED_NODE_PATTERN`） |
| `ini.ts` | 解析 `full.ini`（`parseRuleSets`、`parseProxyGroups`、`rulesetSlug`） |
| `cache.ts` | `cachedFetch`（规则 30 天）；订阅 `SUB_CACHE_TTL` 到期再拉、失败回退旧值；`fetchSubLines`、`cacheKey` |
| `proxy.ts` | 解析代理 URI（ss/ssr/vmess/vless/trojan/hy2/tuic），输出 Surge 行或 Clash YAML |
| `ruleset.ts` | `/ruleset/:index-:name` 端点，拉取上游规则集并按客户端类型转换 |
| `shadowrocket.ts` | 生成 SR `.conf`：读 `shadowrocket/template.conf`，注入策略组和规则 |
| `surge.ts` | 生成 Surge `.conf`：读 `surge/template.conf`，内嵌节点，注入策略组和规则 |
| `clash.ts` | 生成 Clash `.yaml`：内嵌 proxies，生成 proxy-groups、rule-providers |
| `status.ts` | `/status` 端点：客户端列表 + 缓存状态 + 刷新 |

---

## 端点列表

| 端点 | 鉴权 | 说明 |
|---|---|---|
| `GET /` | 无 | 帮助文本 |
| `GET /sub?key=K` | 需要 | SR 节点订阅（PROXY@/DIRECT@/RELAY@ 前缀 + chain 参数） |
| `GET /config?key=K` | 需要 | 按 UA 自动选客户端，返回配置文件 |
| `GET /config?key=K&target=surge\|clash\|shadowrocket` | 需要 | 强制指定客户端 |
| `GET /ruleset/:index-:name?t=shadowrocket\|surge` | 无 | 规则集（公开，按客户端类型转换） |
| `GET /status?key=K` | 需要 | 缓存状态 JSON |
| `GET /status?key=K&refresh=1\|shadowrocket\|surge\|clash\|sub` | 需要 | 刷新指定范围的缓存 |

参数 `&force=1` 对所有需要缓存的端点有效，跳过 KV 读取强制拉取上游。

---

## UA 分流规则

```typescript
if (/Shadowrocket/i.test(ua)) → 'shadowrocket'
if (/Surge/i.test(ua))        → 'surge'
if (/clash|mihomo|stash|meta/i.test(ua)) → 'clash'
// 未知 UA 默认 → 'shadowrocket'
```

`?target=` 参数优先于 UA。

---

## 链式代理（chain proxy）设计

三端各用原生机制，无需 Worker 做额外路由：

| 客户端 | 落地节点 | 中转节点 | 链式机制 |
|---|---|---|---|
| Shadowrocket `/sub` | 名称加 `PROXY@` 前缀，URI 加 `chain=🔀 中转代理` | 名称加 `RELAY@` 前缀 | SR 原生 chain 参数 |
| Surge | 节点行末加 `, underlying-proxy=🔀 中转代理` | 独立节点行，无 underlying-proxy | Surge 原生 underlying-proxy |
| Clash | 节点 YAML 加 `dialer-proxy: "🔀 中转代理"` | 独立节点，无 dialer-proxy | Mihomo 原生 dialer-proxy |

不支持 SR chain 的协议（`PROXYPASS_UNSUPPORTED`）在 `/sub` 中改用 `DIRECT@` 前缀。

---

## 缓存键设计

```
cache:SHA256(url)        ← 原始内容（规则 30 天；PROXY_SUBS/RELAY_SUBS 正文不过期）
subfresh:SHA256(url)     ← 订阅上次成功拉取的 unix 秒，用来判断 SUB_CACHE_TTL
ruleset:surge:URL        ← handleRuleset() 缓存 Surge 转换结果（1 天）
ruleset:shadowrocket:URL ← handleRuleset() 缓存 SR 转换结果（1 天）
```

`refresh=surge` 时：刷新 raw cache，同时删除 `ruleset:surge:*` 强制下次重新转换。

---

## 规则集 URL 格式

```
/ruleset/{index}-{slug}?t=surge|shadowrocket
```

- `index`：`full.ini` 中 URL 型 ruleset 的 1-based 序号（跳过 `[]` 内联规则）
- `slug`：上游文件名去扩展名后的小写连字符形式（`Sony.list` → `sony`）
- 路由匹配：`/^\/ruleset\/(\d+)(?:-[^/?]*)?$/`，只用前缀数字做查找

---

## 如何新增客户端

以新增 **QuantumultX** 为例，完整步骤：

### 1. 新建 `src/quantumultx.ts`

参考 `surge.ts` 结构：

```typescript
import { Env } from './types.js';
import { fetchRepoFile, parseRuleSets, parseProxyGroups, fetchFullIni, rulesetSlug } from './ini.js';
import { fetchSubLines } from './cache.js';
import { parseProxiesFromSubscription, ParsedProxy } from './proxy.js';

export async function generateQuantumultX(env: Env, selfBase: string, force = false): Promise<string> {
  const [ini, template, landingLines, relayLines] = await Promise.all([...]);
  // 生成 [server_local] / [filter_remote] / [policy] 等段
  return result;
}
```

### 2. 扩展 `src/proxy.ts`

`toQuantumultXLine(proxy: ParsedProxy): string | null` 函数，输出 QX 代理行格式：

```
vmess=host:port, method=none, password=uuid, fast-open=false, udp-relay=true, tag=NodeName
```

### 3. 扩展 `src/types.ts`

```typescript
export type ClientTarget = 'shadowrocket' | 'surge' | 'clash' | 'quantumultx';
```

在 `SURGE_SUPPORTED_TYPES` 旁边按需增加：
```typescript
export const QX_SUPPORTED_TYPES = new Set(['ss', 'vmess', 'vless', 'trojan', 'hy2']);
```

### 4. 扩展 `src/ruleset.ts`

`convertRulesetContent` 已按 `ClientTarget` 分支，添加 `quantumultx` 分支：
- QX filter remote 格式与 Surge 规则类型基本兼容，可共用 SURGE 的转换逻辑

### 5. 添加模板（如需）

在仓库根目录 `quantumultx/template.conf` 放静态段（General、DNS 等），加 `{{POLICY_SECTION}}`、`{{FILTER_SECTION}}` 占位符。Worker 运行时拉取此文件，与 `REPO_BASE_URL` 拼接。

### 6. 更新 `src/index.ts`

```typescript
// UA 检测
if (/QuantumultX/i.test(ua)) return 'quantumultx';

// 路由
if (target === 'quantumultx') {
  const config = await generateQuantumultX(env, selfBase, force);
  return new Response(config, {
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'Content-Disposition': 'attachment; filename="MySub.conf"',
    },
  });
}
```

### 7. 更新 `src/status.ts`

`inScope` 函数中为新客户端添加刷新范围：

```typescript
if (scope === 'quantumultx') return label === 'full.ini' || label.includes('quantumultx/template') || isSub || isRuleset;
```

### 8. 部署

```sh
cd worker
npx wrangler deploy
```

---

## Secrets 配置

通过 `wrangler secret put <NAME>` 设置，不提交到代码：

| 变量 | 说明 |
|---|---|
| `SECRET_KEY` | URL 鉴权 `?key=` |
| `PROXY_SUBS` | 逗号分隔的落地代理订阅 URL（标准 base64 URI 格式） |
| `RELAY_SUBS` | 逗号分隔的中转节点订阅 URL（同格式，可选） |

可选 `wrangler.toml [vars]`：

| 变量 | 默认值 | 说明 |
|---|---|---|
| `REPO_BASE_URL` | `https://raw.githubusercontent.com/monlor/subconverter-rules/main/` | 运行时拉取仓库文件的 base URL |
| `SURGE_INTERFACE` | 无 | Surge 默认出口网卡（如 `en0`） |
| `SUB_CACHE_TTL` | `3600` | `PROXY_SUBS`/`RELAY_SUBS` 刷新间隔（秒）。`0` = 每次请求都拉；失败仍用旧值 |

---

## 本地开发

```sh
cd worker
npm install
npx wrangler dev
```

`.dev.vars` 填写本地测试用 secrets：
```
SECRET_KEY=test
PROXY_SUBS=https://...
RELAY_SUBS=https://...
```

---

## 关键约束

- `full.ini` 里的 `(?i)` 正则前缀是 Python/PCRE 语法，JS 中用 `toJsRegex()` 转换（在 `clash.ts`）。各处 `new RegExp(pattern, 'i')` 之前需先调用。
- `gh.monlor.com/` 代理前缀由 `cache.ts` 的 `normalizeUrl()` 自动剥离，`full.ini` 内的 ruleset URL 不需要手动修改。
- Clash rule-providers 直接指向上游 URL，不经过 `/ruleset/` 端点，Worker 无需缓存转换结果。
- 规则集转换缓存（`ruleset:target:URL`）TTL 为 1 天；规则原始内容缓存 30 天；`PROXY_SUBS`/`RELAY_SUBS` 正文不过期，`SUB_CACHE_TTL`（默认 3600 秒）到期后再拉，失败一直用旧值。刷新时先更新原始缓存，再删除转换缓存。
