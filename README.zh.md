# dsh-auto-compact

DeepSeek Harness 插件：当会话上下文达到用户设定的绝对 token 阈值时，自动调用
Harness 自带的 compaction 引擎（内置 `/compact` 命令背后的同一个 `ctx.compaction`
后端）压缩较早的历史。

[English](README.md)

## 功能

- 在每次 `agent/pre-step`（模型调用前）用平台 `ctx.tokenMeter` 测量当前上下文。
- 达到阈值后自动选择较早的一段历史，通过内置 `ctx.compaction.compactRegion()`
  生成摘要检查点并替换被压缩的历史。
- 阈值可配置，默认 **262144 tokens（256K）**。
- 保留最近的尾部历史不压缩，默认保留 **32768 tokens（32K）**。
- 每次检查最多连续压缩 **3** 次；所有失败只记录日志，不会中断当前会话。
- 压缩前会按 tool-call/tool-result 配对找到安全切点，不会把未完成的工具调用与
  其结果拆开。

## 环境要求

- DeepSeek Harness `0.1.0-rc.6`
- 目标 agent preset 中已挂载 `@deepseek-ai/dsh-compaction-basic`（内置
  `/compact` 的后端；官方 standard/code/cordis preset 以及
  `minimal-compact`/`anchored-standard` 都已有）

## 安装

Web profile 的 compaction 服务在 **agent preset** 里（不在 profile bundle 中），
所以本插件安装进本地 preset 的 compaction 组：

```bash
cd /path/to/dsh-auto-compact
./install.sh
```

脚本会扫描 `~/.dsh/.agent-presets`，对所有已包含 `compaction-basic` 的 preset：

1. 把 `lib/index.js` 复制为 `<preset>/dsh-auto-compact.mjs`；
2. 在 `compaction-basic` 行之后插入：

```yaml
    - id: auto-compact
      name: ./dsh-auto-compact.mjs
      config:
        thresholdTokens: 262144
        retainTokens: 32768
        maxCompactions: 3
        enabled: true
```

只安装指定 preset：

```bash
./install.sh --preset anchored-standard
./install.sh --preset anchored-standard --threshold 128k
```

安装后，**新建一个会话**（或重启 `dsh web`）即可生效。已经存在的会话会继续使用
创建时的 preset 版本，不会被热切换。

## 配置

直接编辑 `~/.dsh/.agent-presets/<preset-id>/agent.cordis.yml` 中
`auto-compact` 行的 `config`：

| 键 | 默认值 | 说明 |
|---|---|---|
| `thresholdTokens` | `262144` | 自动压缩阈值；数字或 `128k` / `1m` 形式 |
| `retainTokens` | `32768` | 压缩时至少保留的最近历史 token 数 |
| `maxCompactions` | `3` | 一次检查中最多连续压缩次数 |
| `enabled` | `true` | 设为 `false` 可临时停用，无需卸载 |

例如把阈值改成 128K：

```yaml
    - id: auto-compact
      name: ./dsh-auto-compact.mjs
      config:
        thresholdTokens: 131072
```

改完同样需要对**新会话**生效。

## 与内置自动压缩的关系

Harness 内置的 `compaction-basic` 已经有一个按上下文窗口比例（默认 0.8）触发的
自动压缩。本插件在其之后运行，提供独立于模型窗口比例的**绝对 token 阈值**：

- 内置按比例先触发时，本插件复测后不再重复压缩；
- 内置阈值高于你设置的绝对阈值时，本插件会先于内置策略触发；
- 两者调用的是同一个 `ctx.compaction` 服务，锁、持久化、摘要格式完全一致。

## 卸载

```bash
./uninstall.sh
# 或只卸载指定 preset
./uninstall.sh --preset anchored-standard
```

卸载会移除 `agent.cordis.yml` 中的 `auto-compact` 行块并删除
`dsh-auto-compact.mjs`。新建会话后生效。

## 安全边界

- 只读平台服务：`ctx.tokenMeter`、`ctx.compaction`，不注册任何 HTTP 接口或工具。
- 所有实际压缩逻辑（范围校验、工具调用配对、摘要生成、日志锁、持久化）都在
  Harness 内置 compaction 后端中执行。
- 插件本身无任何运行时 npm 依赖，以本地文件形式挂载在 preset 内。

## License

[MIT](LICENSE)
