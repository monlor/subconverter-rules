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
