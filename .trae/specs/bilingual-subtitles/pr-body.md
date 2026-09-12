## Summary

Implements the bilingual subtitle feature requested in #2019, replacing the earlier #2487 approach. When enabled, AIRI speaks one language and shows one or two translated subtitle lines in the desktop caption window.

The model is prompted (per-send snapshot, same `airi-runtime-prompt` ReplaceSelf context) to emit tagged blocks:

```text
[EN] Hello, how are you?
[ZH] 你好吗？
```

A streaming splitter separates spoken text from translations **before the TTS fork**, so both REST segmenter and official bidirectional-ws speech read only the spoken language. Translations reach only the caption window through a new `onTokenTranslation` hook and a per-turn playback pairing tracker — they never enter the chat bubble, stored history, or cloud sync.

On the alternative suggested in the #2487 discussion (reuse `stripNarrative` / bracket stripping): `stripNarrative` is dormant production code, only strips after full text, has no language identity or sentence pairing, and its brackets collide with markdown links (`[x](y)`), array indices, and narration. It cannot drive a second subtitle track. This tagged-splitter design covers both TTS transports without 2× token latency or cross-window demux state.

## Changes

- `pipelines-audio`: `createBilingualTurnSplitter` — bounded prefix hold-back (max 4 chars), markdown-link/array-index/unknown-tag passthrough, case-sensitive tags, EOF-safe flush, 12-language table.
- `core-agent`: optional `getBilingualSnapshot` per-send dep; spoken/translation split after the speech categorizer; spoken keeps the existing literal hook (TTS + bubble + history), translation goes only to the isolated `onTokenTranslation` hook; control tags never reach TTS, the bubble, or stored messages.
- `stage-ui`: `useBilingualCaptions` tracker pairs translation fragments with ordered playback items (multi-item sentences, whole-turn buffered items, late translations, punctuation tolerance, turn-end flush for rejected TTS); settings store (non-synced) with reset registration; prompt instruction joined into the existing runtime-prompt context; Stage.vue thin wiring (~50 net lines).
- Spark reactions supported: the bilingual instruction is appended to the spark-notify request as a system instruction, the character store splits each reaction from a per-reaction snapshot (spoken → TTS + reaction history, translated → captions), and chat/spark share one process-wide `useBilingualCaptionBus`.
- Caption lifetime: spoken playback events refresh the translation line's TTL, so long responses no longer drop translations before speech finishes.
- Settings: new Modules → Bilingual subtitles page (spoken + two subtitle languages, voice-language warning); module grid entry.
- `stage-shared`: `caption-assistant-translation` event type with optional language label.
- `stage-tamagotchi`: caption window renders a smaller translated line with a language badge (inline names for two languages); unified broadcast watch.

Out of scope: stage-web/pocket overlay UI, automatic voice switching, `stripNarrative` activation, history backfill.

## Verification

- `pnpm -F @proj-airi/pipelines-audio exec vitest run` — splitter 19/19 (3 pre-existing failures in `playback-manager.test.ts` fail without these changes too)
- `pnpm exec vitest run --project @proj-airi/core-agent` — 97/97
- `pnpm -F @proj-airi/stage-ui exec vitest run --project node` targeted: bilingual captions 13/13, chat contract 35/35
- `pnpm exec vitest run --project stage-tamagotchi:node` — useCaptionItems 4/4
- `pnpm typecheck` — 52/52 packages
- `pnpm lint` — 0 errors
- `pnpm -F @proj-airi/stage-tamagotchi build` — passes
- Manual: pending (needs configured LLM/TTS credentials) — EN speech + ZH captions, markdown passthrough, toggle-off parity, mid-response settings change

## Visual changes

Pending: before/after Vishot captures of the settings module page and the caption window translation line.
