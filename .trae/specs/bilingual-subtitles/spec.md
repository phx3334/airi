# 双语字幕（Bilingual Subtitles）规格说明

* 上游 issue：[moeru-ai/airi#2019](https://github.com/moeru-ai/airi/issues/2019)（accepted / urgent）

* 取代已关闭的 PR #2487（同一作者重开）

* 响应 PR #2487 评论中 dasilva333 提出的 UST/括号方案（[评论](https://github.com/moeru-ai/airi/pull/2487#issuecomment-5636342572)）

## 1. 目标

用户可配置 TTS 口语语言与字幕翻译语言：模型用口语语言回答并在同一条回复中附上译文；TTS 只合成口语；桌面字幕窗口在主字幕行之外，增加一行带语言标签的译文。译文只出现在字幕窗口，不进入聊天气泡、消息历史或云同步。

## 2. 方案决策：混合架构

采用「**语言标签语义 + 括号定界**」，并把 #2487 堆在 Stage.vue 的状态机下沉为可单测的纯模块。

线上格式（prompt 约定，逐句交错）：

```text
[EN] Hello, how are you?
[ZH] 你好，今天过得怎么样？
[EN] I am AIRI.
[ZH] 我是 AIRI。
```

关键规则（全部来自 #2487 的真实踩坑，作为硬约束）：

1. **前缀门控 hold-back**：只有当 `[` 之后的字符序列是「某个已配置语言标签前缀」时才短暂截留；一旦不可能匹配任何标签（如 `[http`、`[1]`、markdown 链接、数组下标），立即原样放行。截留长度上限 = 最长标签长度 + 1。
2. **未知标签原样吐出**：解析不出的 `[XX]` 作为普通文本进入当前语言流，绝不静默吞掉。
3. **控制标签本身不进入任何文本流**（不进 TTS、不进聊天记录、不进字幕）；**译文只进字幕轨道，不进聊天气泡/历史/云同步**。
4. **请求快照**：解析器在每轮请求构造时按当时设置创建；回复中途改设置不影响在途回复。
5. **切分点在 TTS fork 之前**：口语文本仍走现有 `onTokenLiteral` → TTS 链路，REST segmenter 与 bidirectional-ws 两条 TTS 路径自动同时生效，不依赖 `stripNarrative`。
6. **默认关闭**；关闭后所有数据流与今天完全一致（解析器不构造）。

### 为什么不纯用思路二（stripNarrative/UST）

* `stripNarrative` 当前是沉睡代码（生产无调用方、无设置开关），且只在 REST segmenter 路径存在；官方 WS 流式 TTS 完全绕过 chunker。

* 字幕当前由「播放项 onStart」驱动（剥离后的文本），要显示译文仍需第二字幕轨道、括号提取、跨窗口广播、与播放分句配对——demux/同步工作量相同，但括号里是译文还是旁白 `(笑)`/`[pause]` 无法区分，markdown `[x](y)` 会被误剥。

* 无语言身份：无法显示语言标签、无法做请求级语言一致性。

* `stripNarrative`（旁白剥离）是正交功能，本次**不启用、不改动**，留给独立 PR。

## 3. 架构与数据流

```text
LLM text-delta
  └─ core-agent orchestrator（现有 marker parser → speech categorizer）
       └─ BilingualTurnSplitter（pipelines-audio 纯模块，仅快照存在时构造）
            ├─ spoken 事件 ──→ buildingMessage.content（聊天气泡与历史，仅口语）
            │                └─ emitTokenLiteralHooks ──→ Stage TTS（两条传输路径不变）
            │                                              └─ playback onStart ──→ caption-assistant（现有行）
            ├─ translation 事件 ─→ 不进任何聊天数据；仅 emitTokenTranslationHooks
            │                    └─ Stage 配对器 ──→ caption-assistant-translation（新行，带 label）
            └─ end：未闭合候选追加进气泡（不进 TTS），不静默丢字
```

配对时序（译文与音频对齐）：

* splitter 按标签切换产生 `pairId`：口语块开启新 pair，随后的译文块归属该 pair。

* Stage 侧新增纯逻辑 composable `use-bilingual-captions`：按 turn 缓存 pair，播放项 `onStart(item.text)` 时用**有序指针 + 双向 startsWith 片段判定**找到对应 pair（TTS 会把一句切成 ≤12 词的多个播放项），发布该 pair 译文（`operation: 'replace'` + label）。

* 一个播放项包含整轮文本时（seed-tts-2.0/seed-icl-2.0 的 `bufferEntireSession`），一次性发布其覆盖的全部 pair 的合并译文。

* 新消息 / turn 重置走现有 `resetAssistantSpeechSurface`：清空 pair 缓存并广播空译文事件清行。

* turn 结束（`onAssistantResponseEnd`）冲刷剩余 pair（尾句译文可能略晚于音频，可接受）。

## 4. 变更范围

### 4.1 `packages/pipelines-audio`（纯逻辑 + 单测）

* 新增 `src/processors/bilingual-turn-splitter.ts`：

  * 语言表：ISO 639-1 code → `{ tag, label }`，首版覆盖 en、zh、ja、ko、es、fr、de、ru、pt、it、vi、th（可后续扩充；tag 为大写 code，zh 用 `ZH`，与 #2487 收敛结论一致，只接受 prompt 里教的那一种拼写）。

  * `createBilingualTurnSplitter(snapshot)`：`consume(chunk)` / `end()`，事件类型：

    * `{ kind: 'spoken', text: string }`

    * `{ kind: 'translation', language: string, text: string, pairId: number }`

  * 快照：`{ spokenLanguage: string, translationLanguages: string[] }`。

  * 完整 JSDoc、`@example`、流式状态机注释（起始语言=口语语言；截留缓冲；pairId 递增规则；EOF 冲刷）。

* 新增同名 `.test.ts`（Vitest）：标签跨 chunk 到达、前缀门控放行 markdown/数组/普通括号、未知标签原样、EOF 未闭合、CJK、嵌套方括号、pairId 归属、空白与换行保留。

* `src/index.ts` 导出。

### 4.2 `packages/stage-shared`

* `src/caption.ts`：

  * `CaptionChannelEvent.type` 增加 `'caption-assistant-translation'`。

  * 增加可选 `label?: string`（语言显示名，如「中文」「日本語」）。

### 4.3 `packages/core-agent`

* `src/contracts/hook-types.ts` + `src/runtime/agent-hooks.ts`：增加 `onTokenTranslation` / `emitTokenTranslationHooks`，payload：`{ language: string, text: string, pairId: number }`。

* `src/runtime/chat-orchestrator-runtime.ts`：

  * 新增可选 dep `getBilingualSnapshot?: () => { spokenLanguage: string, translationLanguages: string[] } | undefined`。

  * 在每轮 parser 创建时取一次快照（仅对通过 speech categorizer 的文本生效）；快照为 undefined 时路径零变化。

  *- spoken 事件走现有 content 累积 + `emitTokenLiteralHooks`；translation 事件**只**发新 hook，不写 content/slices（历史只保留口语）。
  - parser `end` 时未闭合候选追加进 content（不进 TTS），不静默丢字。
  - 注意：`streamingMessageContext` / slices / cloud sync 结构不变；`fullText` 仍为原文用于最终 categorization。

* 编排器测试补充：开启时投影正确、translation hook 载荷与 pairId；关闭时字节级行为不变；模型未输出标签时全部为 spoken。

### 4.4 `packages/stage-ui`

* 新增 `src/stores/settings/bilingual-subtitles.ts`：普通持久化 store（`useLocalStorageManualReset`，**不进 pinia synced**——只有 Stage 宿主窗口消费设置，字幕窗口只读广播事件）。

  * 键：`settings/bilingual/enabled`（默认 false）、`settings/bilingual/spoken-language`（默认 `en`）、`settings/bilingual/translation-languages`（默认 `['zh']`，UI 允许 1–2 个）。

  * 导出 `snapshot()`（普通对象）与语言表（复用 pipelines-audio 的表）。

  * 在桌面端「设置重置」既有清单中注册这些键（实现时定位 data reset 的模块键注册表）。

* `src/stores/chat.ts`：

  * 注入 `getBilingualSnapshot` dep。

  * 双语指令拼进**同一个** `airi-runtime-prompt` context（与现有 runtimePrompt join 后交给 `createRuntimePromptContext`），避免 #2487 遇到的「provider 返回空导致旧 context 残留在注册表」问题；关闭时 join 结果不含指令，同 id ReplaceSelf 自动覆盖。

* 新增 `src/composables/use-bilingual-captions.ts`（纯配对状态机 + 单测）：

  * 输入：translation hook 事件（带 turnId，取自 `ChatStreamEventContext.turnId`）、`onPlaybackText(turnId, text)`、`reset(turnId)`、`flushTurn(turnId)`。

  * 输出：待广播的 caption 事件列表（replace 语义、多语言合并、带 label）。

  * 不接触 BroadcastChannel / Vue 渲染之外的副作用，保证可测。

* `src/components/scenes/Stage.vue`（目标净增 < 80 行）：

  * 注册 `onTokenTranslation` → 配对器；现有 playback `onStart` 增加一次配对器查询并 `postCaption`；`resetAssistantSpeechSurface` 增加清行；`onAssistantResponseEnd` flush。

  * 不做按语言自动切换音色（#2487 大量 bug 的来源）：设置页对当前 voice 不支持口语语言时显示警告，不自动重选。

* 设置 UI：

  * 新增 `src/components/scenarios/settings/bilingual-subtitles.vue`（开关 + 三个语言下拉：TTS 语言、字幕语言 1（默认等于 TTS）、字幕语言 2（可选）；语言名用各语言自称：English、中文、日本語…）。

  * 在 `use-modules-list` 注册模块入口。

  * i18n：只改 `packages/i18n/src/locales/en/settings.yaml` 与 `zh-Hans/settings.yaml`（Crowdin 规则）。

### 4.5 `packages/stage-pages`

* 新增 `src/pages/settings/modules/bilingual-subtitles.vue` 包装页（`<route lang="yaml">`，layout: settings，参照同类页面）。

### 4.6 `apps/stage-tamagotchi`

* `src/renderer/composables/useCaptionItems.ts`：`CaptionItem` 与 add/replace 透传 `label`。

* `src/renderer/pages/caption.vue`：

  * 增加 `caption-assistant-translation` 第三行：较小字号、中性色、可选语言标签徽章（UnoCSS 规则：禁止长内联工具串，用 class 数组分组——#2487 已被要求过同样修改）。
  * 译文字幕 TTL 锚定语音播放：每条 `caption-assistant` 播放事件刷新译文行过期计时，长回复期间译文不再先于口语消失；语音停止一个 TTL 后正常清行。

  * watch 分支简化为统一 `addCaptionItem(event)`。

## 5. Prompt 指令（英文源语言，运行时拼接）

由设置生成，大意（实现时定稿，需包含）：

* 用 `{spoken}` 自然口语化回答；每句之后在下一行用 `{lang}` 给出该句译文。

* 严格格式：语言标签只允许 `[TAG]`（标签来自快照，逐字匹配），标签独占段首；不输出其他括号内容、不解释格式。

* 译文只允许配置中的语言；特殊标记 `<|...|>` 与工具调用规则不受影响，照常使用。

* 一个最小对比例子（EN/ZH 快照时）。

## 6. 边界

1. ~~spark-notify reaction 路径不做~~ **已覆盖**：reaction 请求经 `control.messageOverride.appendSystemInstructions` 注入同一指令；character store 每个 reaction 取一次快照建 splitter——spoken 喂 marker parser/TTS 且作为 `reaction.message` 投影，translation 只进共享字幕总线；spark 播放项自带 `turnId: spark:<eventId>` 用于配对；流结束 endTurn 冲刷未播放 pair；新 reaction interrupt 时清上一条 spark 字幕。chat 与 spark 共用 `useBilingualCaptionBus` 单例（tracker + caption 广播，懒创建 channel 以兼容测试）。
2. stage-web / stage-pocket 的字幕 overlay UI（契约与纯逻辑共享，端侧 UI 后续补；web 当前无任何 caption 消费方）。
3. 按语言自动切换 TTS 音色（改为设置页兼容性警告）。
4. 启用 `stripNarrative` 旁白剥离（独立 PR）。
5. 历史消息回填翻译。

## 7. 验收与测试

* Vitest：splitter、orchestrator、caption 配对器三个测试文件；覆盖 ROOT CAUSE 风格回归注释（标签截留误伤 markdown、跨 chunk 标签、整轮单播放项）。

* `pnpm -F @proj-airi/pipelines-audio exec vitest run`、core-agent、stage-ui、stage-tamagotchi 相关测试通过。

* `pnpm typecheck`、`pnpm lint` 通过。

* 手工验证（桌面，stage-tamagotchi）：开启后 EN 口语 + ZH 译文字幕、TTS 只读英文、聊天记录无标签残留、markdown 链接正常播报；关闭后行为与 main 一致；切换设置不影响在途回复。若启动 dev 服务，验证后关闭。

## 8. 风险与缓解

| 风险             | 缓解                                                   |
| -------------- | ---------------------------------------------------- |
| 模型不按格式输出       | 未知标签原样放行；无标签时等同普通回复；prompt 带唯一示例与严格约束                |
| 字幕与音频错位        | 有序指针配对 + 双向 startsWith；整轮单播放项合并发布；turn 结束 tail flush |
| 在途回复受设置变更污染    | 请求快照，splitter 每轮构造                                   |
| Stage.vue 再度膨胀 | 配对逻辑全部进 composable 并单测，Stage 仅接线，净增 < 80 行           |
| WS 流式 TTS 整轮缓冲 | 播放项含全文本时合并发布所有命中 pair（#2487 已验证该场景）                  |

