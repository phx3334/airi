# 双语字幕 — 实施任务

顺序执行；每个阶段结束运行该包测试/typecheck。所有新文件 kebab-case；JSDoc 与注释遵守 AGENTS.md（simple-english skill）；测试遵守 enforce-rules-for-vitest；样式遵守 enforce-rules-for-unocss。

## 阶段 0：准备

- [ ] 0.1 分支 `phx3334/feat/bilingual-subtitles`（基于最新 main）
- [ ] 0.2 复查 PR #1702（tts-chunker 现有括号处理）确保 splitter 与之语义不冲突；确认不引入重复剥离

## 阶段 1：纯逻辑切分器（pipelines-audio）

- [ ] 1.1 新增 `packages/pipelines-audio/src/processors/bilingual-turn-splitter.ts`
  - 语言表（code → tag/label，12 个语种，zh→ZH）
  - `BilingualTurnSnapshot` 类型；`createBilingualTurnSplitter(snapshot)` 返回 `{ consume(chunk), end() }`
  - 事件：`spoken | translation(pairId)`；前缀门控 hold-back；未知标签原样；EOF 冲刷；起始语言=口语
- [ ] 1.2 新增 `bilingual-turn-splitter.test.ts`
  - 正常双标签交错、标签跨 chunk（每次 1–3 字符）
  - markdown 链接 `[x](y)`、数组下标 `[1]`、普通括号旁白原样放行
  - 未知 `[XX]` 原样进 spoken
  - EOF 未闭合 `[EN` 原样
  - 嵌套方括号、CJK 文本、换行/空白保留
  - pairId 归属（口语块后多个译文块共享同 id）
  - 未配置任何译文语言时全部 spoken
- [ ] 1.3 `src/index.ts` 导出
- [ ] 1.4 `pnpm -F @proj-airi/pipelines-audio exec vitest run` + typecheck

## 阶段 2：字幕契约（stage-shared）

- [ ] 2.1 `src/caption.ts`：type 增加 `'caption-assistant-translation'`，增加 `label?`
- [ ] 2.2 全仓 grep `caption-assistant` 消费方，确认新增 type 不会破坏 exhaustive 分支（caption.vue、useCaptionItems）

## 阶段 3：core-agent 分流

- [ ] 3.1 `hook-types.ts` + `agent-hooks.ts`：新增 `onTokenTranslation` / `emitTokenTranslationHooks`（parallel，异常 logger.warn 不炸流）
- [ ] 3.2 `chat-orchestrator-runtime.ts`
  - dep `getBilingualSnapshot?: () => BilingualTurnSnapshot | undefined`
  - 每轮 parser 构造时取快照并创建 splitter；onLiteral（categorizer 之后）走 splitter；spoken→现有两路；translation→content 投影 + 新 hook；parser end 时 flush 尾部
- [ ] 3.3 编排器测试（参照已有 orchestrator 测试的 mock 风格）：
  - 开启：content 无标签残留、literal 只有口语、translation hook 载荷/语言/pairId 正确
  - 关闭：与改造前字节一致
  - 模型全程无标签：全部 spoken
- [ ] 3.4 运行 core-agent vitest + typecheck

## 阶段 4：设置 store + prompt（stage-ui）

- [ ] 4.1 `src/stores/settings/bilingual-subtitles.ts`：enabled / spokenLanguage（en）/ translationLanguages（['zh']，1–2 个）；`snapshot()`；语言表复用 pipelines-audio
- [ ] 4.2 定位桌面设置重置注册表并登记三个 storage key
- [ ] 4.3 prompt 指令构建（i18n 英文源文案放在 settings yaml / 指令模板就近导出）；在 `chat.ts` 与现有 runtimePrompt join 后交给同一个 `createRuntimePromptContext`；同时把 `getBilingualSnapshot` 注入 orchestrator deps
- [ ] 4.4 stage-ui store 相关测试（如既有 store 测试惯例存在）+ typecheck

## 阶段 5：字幕配对 composable（stage-ui）

- [ ] 5.1 `src/composables/use-bilingual-captions.ts`
  - per-turn：pairs（pairId → {spoken, translations: {language,label,text}}）、有序指针、已发布集合
  - `ingest(turnId, payload)`、`onPlaybackText(turnId, text)` → 返回应 post 的 caption 事件（replace + label，多语言合并）
  - `reset(turnId)`（返回空译文清行事件）、`flushTurn(turnId)`
  - 片段判定：双向 startsWith（trim）；整轮单播放项：发布其覆盖的全部 pair
- [ ] 5.2 `use-bilingual-captions.test.ts`：分句多播放项、乱序容忍（保持顺序指针）、turn 切换清理、tail flush、多译文语言、空译文
- [ ] 5.3 运行 stage-ui vitest

## 阶段 6：Stage.vue 薄层接线（stage-ui）

- [ ] 6.1 注册 `onTokenTranslation`（turnId 取自 context）
- [ ] 6.2 现有 playback onStart 增加 `onPlaybackText` → postCaption（含 label）
- [ ] 6.3 `resetAssistantSpeechSurface` 增加 reset + 空译文广播
- [ ] 6.4 `onAssistantResponseEnd`（或现有 turn 结束点）flush
- [ ] 6.5 检查 Stage.vue 净增 < 80 行；typecheck + lint

## 阶段 7：设置 UI（stage-ui + stage-pages + i18n）

- [ ] 7.1 `src/components/scenarios/settings/bilingual-subtitles.vue`：开关 + TTS 语言 / 字幕语言 1 / 字幕语言 2（可空）下拉 + voice 语言不兼容警告；在 `scenarios/settings/index.ts` 注册
- [ ] 7.2 `use-modules-list` 注册模块入口
- [ ] 7.3 `packages/stage-pages/src/pages/settings/modules/bilingual-subtitles.vue` 包装页 + route meta
- [ ] 7.4 i18n：仅 `locales/en/settings.yaml`、`locales/zh-Hans/settings.yaml` 新增键
- [ ] 7.5 样式遵循 enforce-rules-for-unocss（class 数组分组、无超长内联串）；lint

## 阶段 8：桌面字幕窗口（stage-tamagotchi）

- [ ] 8.1 `useCaptionItems.ts`：透传 `label`
- [ ] 8.2 `pages/caption.vue`：译文第三行（字号/颜色弱化、label 徽章）；watch 收敛为统一 add 分支
- [ ] 8.3 typecheck + 该 app vitest

## 阶段 9：整体验证

- [ ] 9.1 `pnpm typecheck`（全包）
- [ ] 9.2 `pnpm lint`
- [ ] 9.3 `pnpm test:run`（至少受影响包全部通过）
- [ ] 9.4 桌面手工验证（启动后按用户要求关闭服务）：
  - EN 口语 + ZH 译文字幕对齐；TTS 只读英文；气泡与历史无标签
  - 含 markdown 链接/方括号的回复播报正常
  - 关闭功能后与 main 行为一致
  - 回复途中改设置不影响在途回复
  - 字幕窗口译文行 TTL 清除正常

## 阶段 10：PR

- [ ] 10.1 用 repo 本地 `create-pr` skill 开 PR（分支 username/feat/short-name、Conventional Commits、无 gitmoji）
- [ ] 10.2 PR 描述说明对思路二（stripNarrative）的评估结论；回应 #2019 验收标准
