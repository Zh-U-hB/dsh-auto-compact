# dsh-auto-compact

DeepSeek Harness 插件：当会话上下文达到用户设定的绝对 token 阈值时，自动调用
Harness 自带的 compaction 引擎（内置 `/compact` 命令背后的同一个 `ctx.compaction`
后端）压缩较早的历史。

[English](README.md)

## 为什么它能覆盖所有会话

插件安装在 **host plane（profile bundle）**，不是某个 agent preset 里：

- 它监听整个进程的 `agent/pre-step`，所以对**每个会话**都生效；
- 每个 agent 通过 `agent.ctx.get('compaction')` 解析**该会话自己的** compaction
  后端，因此无论会话用哪个 preset（standard / minimal / 本地自定义，以及
  subagent），只要有 compaction 后端就自动启用；
- 会话 resume 后同样生效；不要求“新建会话”才带上插件。

## 功能

- 每次模型调用前用平台 `ctx.tokenMeter` 测量当前上下文。
- 达到阈值后自动选择较早的一段历史，通过内置 `ctx.compaction.compactRegion()`
  生成摘要检查点并替换被压缩的历史。
- 阈值可配置，默认 **262144 tokens（256K）**。
- 保留最近 **32768 tokens（32K）** 不压缩；每次检查最多连续压缩 **3** 次。
- 压缩失败只记录日志，不会中断会话。
- 自动按 tool-call/tool-result 配对找到安全切点。

## 环境要求

- DeepSeek Harness `0.1.0-rc.6`
- `PATH` 中有 `dsh` 和 `pnpm`
- 会话所用 preset 挂载了 `@deepseek-ai/dsh-compaction-basic`（官方
  standard/code/cordis 以及 `minimal-compact`/`anchored-standard` 都已挂载；
  没有 compaction 后端的 preset 会被自动跳过）

## 安装

```bash
cd /path/to/dsh-auto-compact
./install.sh
```

安装脚本会：

1. 清理旧版本遗留在 preset 文件里的行；
2. 执行 `dsh plugin --profile web add <插件目录>`，把插件加入 web profile
   的 bundle 列表，并自动追加：

```yaml
- id: auto-compact
  name: dsh-auto-compact
```

安装后**重启 `dsh web`**（host-plane bundle 在启动时加载），浏览器硬刷新一次：

```bash
dsh web
```

之后所有会话、所有 preset 都会经过该阈值检查。

## 配置

全局配置写在 `~/.dsh/profiles/web/cordis.patch.yml`，对整个 profile 的所有会话
生效（默认值不写也可以）：

```yaml
- id: auto-compact
  config:
    thresholdTokens: 262144   # 默认 256K，也可写 128k / 1m
    retainTokens: 32768       # 至少保留的最近历史
    maxCompactions: 3         # 一次检查最多连续压缩次数
    enabled: true             # 临时关闭可设 false
```

改完重启 `dsh web` 生效。

## 与内置自动压缩的关系

内置 `compaction-basic` 已按上下文窗口比例（默认 0.8）自动压缩。本插件在其
之外提供**绝对 token 阈值**；两者共用同一个 `ctx.compaction` 服务，锁、
持久化与摘要格式完全一致，不会互相冲突。

## 卸载

```bash
./uninstall.sh
```

然后重启 `dsh web`。

## 安全边界

- 只读平台服务：`ctx.tokenMeter`、`ctx.compaction`，不注册 HTTP 接口或工具。
- 实际压缩逻辑全部在 Harness 内置 compaction 后端中执行。
- 无任何运行时 npm 依赖。

## License

[MIT](LICENSE)
