# dsh-auto-compact

[English](./README.md) | [中文](#dsh-auto-compact)

一个 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 插件：
当会话的已测量上下文达到**用户设定的绝对 token 阈值**时，自动调用 Harness
内置的 compaction 引擎压缩较早的历史。

它不发明新的摘要器，而是驱动 Harness 自带的 `ctx.compaction` 服务——也就是内置
`/compact` 命令背后的同一个后端——走完全相同的持久化、加锁、表面替换流程。本插件
只额外增加一个用户可控的**绝对阈值策略**。

默认阈值：**262144 tokens（256K）**。

---

## 目录

- [为什么需要它](#为什么需要它)
- [工作原理](#工作原理)
- [覆盖范围：所有会话、所有 preset](#覆盖范围所有会话所有-preset)
- [功能特性](#功能特性)
- [环境要求](#环境要求)
- [安装](#安装)
- [配置](#配置)
- [行为语义](#行为语义)
- [日志](#日志)
- [卸载](#卸载)
- [本地开发与测试](#本地开发与测试)
- [目录结构](#目录结构)
- [兼容性](#兼容性)
- [常见问题](#常见问题)
- [安全模型](#安全模型)
- [License](#license)

---

## 为什么需要它

Harness 内置的 `@deepseek-ai/dsh-compaction-basic` 已经会按比例自动压缩，但它的
触发点是**相对值**：当前模型上下文窗口的 `thresholdRatio`（默认 0.8）。

这是很好的默认策略，但有些用户希望策略不随模型切换而移动：

| 策略 | 内置 | 本插件 |
|---|---|---|
| 触发点 | `0.8 × 模型上下文窗口` | 显式 token 数，如 `262144` |
| 默认值 | 随模型变化 | `262144`（256K） |
| 作用范围 | 单个 compaction 后端实例 | 进程级，按会话解析各自后端 |
| 手动 `/compact` | 仍然可用 | 仍然可用 |

绝对阈值低于内置比例阈值时，本插件先触发；高于内置阈值时，内置策略可能先压缩，
本插件复测后不再重复。两者共用同一个引擎、同一把锁、同一种摘要格式，不可能并发
压缩同一段历史。

---

## 工作原理

```text
agent/pre-step（每个会话）
        │
        ▼
ctx.tokenMeter.measure(agent.session)
        │
        │  totalTokens < thresholdTokens ?
        ├── 是 ──▶ 什么都不做，继续当前 step
        │
        ▼ 否
解析该 agent 自己的 compaction 后端：
        serviceForAgent(ctx, agent, 'compaction')
        │
        ├── 不存在 ──▶ 每个 agent 只告警一次，跳过（该 preset 没有 /compact）
        │
        ▼ 存在
选择较早的、tool-call/tool-result 配对安全的表面区间
（保留最近至少 retainTokens 的尾部）
        │
        ▼
ctx.compaction.compactRegion(start, end, agent, signal)
        │
        ▼
重新测量；仍超过阈值就再压缩一次
（单次检查最多 maxCompactions 次）
        │
        ▼
无论成功失败，都继续模型 step
```

要点：

1. **测量**使用平台自带的 `ctx.tokenMeter`——内置压缩后端使用的同一个可重放
   估算器。`totalTokens` 包含最近一次持久化请求包络与当前会话表面。
2. **区间选择**从尾部按 token 价格回扫，保留至少 `retainTokens` 的最近历史，
   并把切点继续前移，直到不会拆开未完成的 assistant `tool-call`/`tool-result`
   配对。
3. **执行**是内置的 `ctx.compaction.compactRegion()`：由压缩后端记录持久化的
   `compaction/start` … `compaction/end` 括号、请求模型生成摘要、用单个 user 角色
   检查点替换选中的表面区间。锁、持久化、重试与摘要语义全部属于 Harness，不属于
   本插件。
4. **失败不阻塞**。压缩失败或不可压缩只记日志，模型 step 照常继续；本插件从不
   否决任何 turn。

---

## 覆盖范围：所有会话、所有 preset

插件安装在 **host plane（profile bundle）**，而不是某个 agent preset 内部：

- 进程级注册一个 `agent/pre-step` 监听器；
- 每个事件发生时，通过官方 `serviceForAgent(ctx, agent, 'compaction')` 只读寻址到**该 agent 自己**的
  compaction 服务，因此总是使用正确的、按 preset/会话隔离的后端实例；
- 因此以下情况全部覆盖：
  - 所有挂载了 compaction 后端的 agent preset（`standard`、`code`、`cordis`、
    本地 `minimal-compact`、`anchored-standard` 等）；
  - 新建会话、resume 会话、进程重启后加载的会话；
  - 顶层 agent 与 subagent。

故意不挂 compaction 后端的 preset（例如官方 `minimal`，连 `/compact` 都没有）
会被检测出来并跳过，每个 agent 只告警一次——那里没有可调用的压缩能力。

---

## 功能特性

- 绝对阈值、可配置，默认 `262144` tokens（256K）。
- 支持人类可读单位：`262144`、`"256k"`、`"256K"`、`"1m"`。
- 可配置保留尾部（`retainTokens`，默认 `32768`）。
- 可配置单次检查重试上限（`maxCompactions`，默认 `3`）。
- 可配置总开关（`enabled`，默认 `true`）。
- 感知 tool-call/tool-result 配对，绝不拆开未完成的工具调用。
- 运行时零 npm 依赖，纯 ESM host 插件。
- 全部压缩工作都在 Harness 内置后端中执行。
- 对没有压缩后端的 preset（例如官方的 `minimal`）会自动挂载一个
  `auto: false` 的 `compaction-basic` 后备引擎，因此绝对阈值检查在这些
  preset 中同样生效；preset 其余部分仍保持极简（没有 `/compact` 命令、
  没有 pruner、没有内置比例压力）。
- 空闲/恢复压缩（v0.2.2+）：打开或恢复一个上下文已经超过阈值的会话时，
  会通过内置 `compactNow` 维护路径立即压缩，不需要再发一条消息。
- 安装与卸载脚本幂等。

---

## 环境要求

| 要求 | 版本 / 说明 |
|---|---|
| DeepSeek Harness | `0.1.0-rc.6`（web profile 开发验证版本） |
| `PATH` 中的 `dsh` | 用于 `dsh plugin ...` |
| `PATH` 中的 `pnpm` | `dsh plugin` 内部使用 |
| Node.js | `>= 20`（插件本身无依赖） |
| Preset 压缩后端 | 会话所用 preset 应挂载 `@deepseek-ai/dsh-compaction-basic` |

---

## 安装

### 从本地检出安装

```bash
git clone https://github.com/Zh-U-hB/dsh-auto-compact.git
cd dsh-auto-compact
./install.sh
```

如果仓库已经检出：

```bash
cd /path/to/dsh-auto-compact
./install.sh
```

### `install.sh` 做了什么

1. 清理早期原型可能写入 `~/.dsh/.agent-presets/*/agent.cordis.yml` 的旧行；
2. 执行：

   ```bash
   dsh plugin --profile web add /absolute/path/to/dsh-auto-compact
   ```

   由于 `package.json` 声明了 `dsh.bundle.patch`，`dsh plugin` 会把 bundle
   追加到 web profile 并插入：

   ```yaml
   - id: auto-compact
     name: dsh-auto-compact
   ```

### 启用

Profile bundle 在进程启动时加载，因此重启 web 服务：

```bash
# 在运行 dsh web 的终端 Ctrl+C，然后：
dsh web
```

随后浏览器硬刷新一次（`Cmd+Shift+R` / `Ctrl+Shift+R`）。

从这一刻起，策略对进程内**所有会话**生效，包括之后 resume 的会话。

### 安装到其它 profile

```bash
DSH_PROFILE=tui ./install.sh        # 或任意其它 profile 名
```

对没有 agent preset 的 profile，只要该 profile 在 host plane 组合了
`ctx.compaction` 后端和 `ctx.tokenMeter`（标准 `dsh-base` 组合就是如此），插件
同样工作。

---

### 在 Web 设置界面里手动设置阈值（v0.2.0+）

打开界面左下角设置，进入 **Plugins → Configurable**，使用 **Auto Compact**
卡片即可手动修改压缩阈值。输入框支持纯数字（`262144`）或人类可读单位
（`256k`、`1m`，按 1024 换算）。保存后通过平台的 settings 服务写入 profile 的
`settings.yaml`，重启后仍然生效，并优先于下面的行配置；点击 **Discard** 可恢复
为行配置（没有行配置时回到 256K 默认值）。

设置卡片作为插件的 client bundle 随包加载，因此从旧版本升级后需要重启一次
`dsh web`。

下面的行级配置仍是基础/默认层：

## 配置

编辑 profile 自己的 patch 层：

```text
~/.dsh/profiles/web/cordis.patch.yml
```

默认配置（下面这段可以不写，每个键都是默认值）：

```yaml
- id: auto-compact
  config:
    thresholdTokens: 262144   # 256 × 1024；也接受 "256k" / "1m"
    retainTokens: 32768       # 至少保留的最近历史
    maxCompactions: 3         # 单次检查最多连续压缩次数
    enabled: true             # false 可在不卸载的情况下暂停
```

示例：

```yaml
# 更早压缩：128K。
- id: auto-compact
  config:
    thresholdTokens: 131072
```

```yaml
# 人类可读单位，并保留更大的尾部。
- id: auto-compact
  config:
    thresholdTokens: 256k
    retainTokens: 64k
```

```yaml
# 暂停但不卸载。
- id: auto-compact
  config:
    enabled: false
```

修改后重启 `dsh web`。

### 校验规则

- `thresholdTokens` 与 `retainTokens` 必须是正整数（或能解析为正整数的
  人类单位字符串）。
- `retainTokens < thresholdTokens`。
- `maxCompactions` 必须是正整数。
- 未知配置键会让插件加载失败并给出明确错误，拼写错误不会静默回落到默认值。

---

## 行为语义

### tokenMeter 重放失败时的降级

如果平台的可重放 `ctx.tokenMeter.measure()` 对某个会话抛错（例如日志在 step
边界被打断，导致某个 `assistant/message` 缺少对应的 `step/start`），插件会临时
包装 tokenMeter 实例，改用“表面 + 最新请求信封”的估算 token 数做压缩决策
（与 token meter 相同的固定密度启发式），并每个会话记录一次
`dsh-auto-compact: tokenMeter replay failed (...)` 警告。这能让损坏但仍可用的
会话继续自动压缩；健康会话完全不经过降级路径。

同一个绝对阈值也会在 `agent/created` 且 agent 空闲时检查，因此恢复一个
早已超阈值的会话时，打开就会压缩。`compactNow` 以 agent maintenance job
运行（与内置 `/compact` 命令同一条路径）；如果 turn 已经开始，则由
pre-step 检查处理。

### 何时检查

检查发生在 `agent/pre-step` 瀑布上——组装该 step 的模型请求之前。由于压缩在
已打开的 turn 内执行，走的是压缩后端的自动压缩路径，与内置比例策略使用同一
机制。

### “上下文达到阈值”是什么意思

使用 `ctx.tokenMeter.measure(session).totalTokens`。它是 Harness 自己的可重放
估算值：最近一次持久化请求包络 + 当前会话表面。它是估算值，不是 provider 精确
token 数，但有意与内置压缩后端比较的是同一个数字。

### 压缩不可能时会发生什么

- 没有安全切点（例如尾部是一个未完成的大工具单元）：每个会话只记录一次告警，
  直到条件消失。
- 达到阈值但后端拒绝（`busy`、`changed`、`summary`、`commit`、`persistence`
  等）：记录错误并继续 step。
- `maxCompactions` 次后仍超阈值：记录告警并继续 turn。单个过大的不可拆分节点
  无法通过表面压缩修复——这是内置后端文档中同样声明的限制。

### 与内置 `/compact` 命令的关系

`/compact` 照常工作。手动命令在空闲 agent 上压缩一个低于压力阈值的有效区间；
本插件在 step 边界、绝对阈值被越过时压缩。两者使用同一个 `ctx.compaction`
实现，因此共享同一把持久化锁，不可能并发或嵌套运行。

### 阈值策略与模型切换

阈值是绝对数，切换路由模型不会改变本插件的触发点。内置比例策略仍会并行运行，
在上下文窗口较小的模型上可能更早触发；这是有意为之，且安全。

---

## 日志

所有消息都带 `dsh-auto-compact:` 前缀，使用 Harness logger：

| 级别 | 消息模式 | 含义 |
|---|---|---|
| `info` | `context at N tokens reached the ... threshold` | 开始一次压缩尝试 |
| `info` | `idle context at N tokens reached the ... threshold` | 空闲/恢复会话无需新消息即压缩 |
| `info` | `idle compaction shadowed ...` | 一次空闲压缩完成 |
| `info` | `compacted N history items (~N tokens shadowed)` | 尝试成功 |
| `warn` | `no tool-pair-balanced older span is compactable` | 超阈值但没有安全区间（按会话限流） |
| `warn` | `context is still at N tokens after N compaction attempt(s)` | 重试上限耗尽（按会话限流） |
| `warn` | `agent "..." has no ctx.compaction service and no fallback engine could be mounted` | 压缩后端不可用；turn 继续（每个 agent 一次） |
| `warn` | `automatic compaction failed (...)` | 后端错误；turn 继续 |

---

## 卸载

```bash
./uninstall.sh
```

脚本执行：

```bash
dsh plugin --profile web remove dsh-auto-compact
```

同时清理任何旧版 preset 内嵌行。之后重启 `dsh web`。

---

## 本地开发与测试

开发无需安装任何依赖：运行时插件零依赖。

```bash
npm test        # node --test 单元 + apply 集成风格测试
npm run check   # 语法检查插件与脚本，然后跑测试
```

测试覆盖：

- 配置解析与校验（默认值、`128k`/`1m`、非法值拒绝）；
- 开放工具配对周围的平衡切点折叠；
- 基于 token-meter 测量的表面区间选择；
- `apply()` 行为：达到阈值、低于阈值、后端抛错、缺少后端（每个 agent 只告警
  一次）。

仓库内含 `test/mount-smoke.mjs`，用于一次性 headless 检查：验证 preset 组合能
挂载并暴露 `ctx.compaction`，且不发任何模型请求。

---

## 目录结构

```text
dsh-auto-compact/
├── lib/
│   ├── index.js              # host 插件：阈值执行 + settings 命名空间
│   └── client.js             # Web 设置卡片（Plugins → Configurable）
├── scripts/
│   └── manage-presets.mjs    # 旧版 preset 行清理工具
├── test/
│   ├── unit.test.mjs         # 配置 + 区间选择单元测试
│   ├── apply.test.mjs        # apply() + settings 集成测试
│   ├── client.test.mjs       # client bundle 注册冒烟测试
│   └── mount-smoke.mjs       # headless preset 挂载冒烟测试
├── cordis.patch.yml          # bundle patch：插入 auto-compact 行
├── install.sh                # dsh plugin add 包装脚本
├── uninstall.sh              # dsh plugin remove 包装脚本
├── package.json              # 包与 dsh.bundle.patch + dsh.client 元数据
└── README.md / README.zh.md
```

---

## 兼容性

开发与验证版本：**DeepSeek Harness `0.1.0-rc.6`**（web profile）。插件依赖的
seam（`ctx.tokenMeter`、`agent/pre-step`、`agent.ctx`、
`ctx.compaction.compactRegion`）目前稳定，但仍属开发者预览内部接口；升级
Harness 后请先重新跑测试并开一个新会话确认。

安装器使用标准 `dsh plugin` 命令，以本地 link 方式安装插件，因此修改本地检出后
重启 `dsh web` 即可看到效果。

---

## 常见问题

### `dsh --profile web --dump-config` 里有插件行，但没有任何反应

进程需要重启。Host-plane bundle 只在启动时加载，磁盘上的 profile 修改不会热
重载进正在运行的 `dsh web`。

### 某个会话从不压缩

- 检查 `enabled` 不是 `false`；
- 检查该会话所用 preset 确实挂载了 `@deepseek-ai/dsh-compaction-basic`（官方
  `minimal` 没有）；
- 在 Harness 日志中查找上述 `dsh-auto-compact:` 消息；
- 记住阈值统计的是整个测量请求包络 + 表面；以工具调用为主的会话比纯文本要
  更晚到达阈值。

### 出现 "has no ctx.compaction service and no fallback engine could be mounted"

从 v0.2.1 起，插件会给没有压缩后端的 preset（包括官方 `minimal`）挂载
`compaction-basic` 后备引擎。只有后备引擎也无法构造时才会出现上面这条
警告，例如 host plane 同时缺少 `@deepseek-ai/dsh-compaction-basic` 或
`@deepseek-ai/dsh-llm`。

### 改了 `cordis.patch.yml` 没变化

Profile patch 修改同样需要重启 `dsh web`。

---

## 安全模型

- 不注册 HTTP 接口、工具、命令或设置写入器；
- 只读取 `ctx.tokenMeter`，并调用会话 preset 已经信任的 `ctx.compaction`
  服务；
- 不做文件路径构造、文件 I/O，也不处理用户输入，只校验自己的 YAML 配置；
- 对会话历史的一切修改都由 Harness 内置压缩后端在其既有的沙箱/持久化规则下
  执行。

---

## License

[MIT](./LICENSE)
