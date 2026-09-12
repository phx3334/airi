# 双语字幕 — 验收清单

## 功能行为

- [ ] 设置开关默认关闭；关闭后 TTS、聊天气泡、字幕、消息存储与 main 行为完全一致
- [ ] 开启后：TTS 只合成口语语言文本，译文从不进入 TTS（REST segmenter 与 bidirectional-ws 两条路径都验证）
- [ ] 字幕窗口显示现有口语行 + 译文行，译文行带语言标签（label）
- [ ] 译文与对应口语播放项在时间上对齐；TTS 把一句切成多个播放项时不错配
- [ ] WS 流式 TTS 整回合合成单个播放项时，全部译文合并显示，不重复、不残留
- [ ] 新消息开始时译文行清空；在途回复不受设置中途变更影响（请求快照）
- [ ] 模型不按格式输出（无标签/未知标签）时回复正常可见、可听，不丢字、不卡尾
- [ ] markdown 链接 `[x](y)`、数组下标 `[1]`、普通括号内容正常进入 TTS 与气泡，不被截留或吞掉
- [ ] 聊天气泡（流式中 + 完成后）、持久化消息、cloud 同步副本只含口语文本：无 `[EN]/[ZH]` 标签，也无译文内容
- [ ] 译文文本仅出现在字幕窗口（caption-assistant-translation），不写入任何消息数据
- [ ] `<|...|>` 特殊标记（emotion/motion 等）行为不受双语功能影响
- [ ] 设置页三个下拉（TTS 语言、字幕语言 1、字幕语言 2 可空）可保存、重载生效
- [ ] voice 不支持口语语言时显示警告；系统不自动替换用户已配置音色
- [ ] 设置重置包含双语三个 storage key
- [ ] spark-notify reaction：启用后 TTS 只读口语、reaction 历史只存口语投影、译文字幕按 spark turnId 配对显示；未启用时字节级旧行为
- [ ] 长回复期间译文字幕随语音播放续期，不会在口语仍在播放时先消失；语音停止后一个 TTL 正常清除

## 架构与代码质量

- [ ] 切分逻辑为 pipelines-audio 纯函数模块，不依赖 Vue/DOM；无 539 行式 Stage.vue 状态机（Stage 净增 < 80 行）
- [ ] 切分点在 core-agent onLiteral、TTS fork 之前；REST 与 WS 路径同时覆盖
- [ ] translation 通过新增 `onTokenTranslation` hook 传递；hook 异常不炸主流
- [ ] prompt 经同一 `airi-runtime-prompt` context（id ReplaceSelf）注入；关闭时无残留指令
- [ ] spark-notify reaction 路径未被改动
- [ ] 未启用/修改 `stripNarrative`
- [ ] 新文件 kebab-case；无相对路径扩展名导入；无 `any`；无向后兼容守卫
- [ ] 公开 API 与非平凡导出有 JSDoc（含 `@example`/`@param` 默认值等，符合 AGENTS.md）
- [ ] 样式符合 UnoCSS 规则（无超长内联工具串、class 分组、遵循现有字幕窗口约定）
- [ ] i18n 仅改 en + zh-Hans；文案用词与既有术语一致

## 测试与工程

- [ ] `bilingual-turn-splitter.test.ts` 覆盖：跨 chunk 标签、前缀门控、未知标签、EOF 冲刷、嵌套括号、pairId、多语言、CJK
- [ ] 编排器测试：开启/关闭/无标签三种情形
- [ ] 字幕配对器测试：多片段、整轮单项、turn 切换清理、tail flush、多译文语言
- [ ] `pnpm -F @proj-airi/pipelines-audio ... vitest run`、core-agent、stage-ui、stage-tamagotchi 相关测试通过
- [ ] `pnpm typecheck` 通过
- [ ] `pnpm lint` 通过
- [ ] 手工验证期间启动的前后端服务已全部关闭
- [ ] PR 通过 create-pr skill 创建；描述包含思路对比与测试说明
