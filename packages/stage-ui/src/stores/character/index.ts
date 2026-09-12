import type { BilingualTurnSplitter, IntentHandle } from '@proj-airi/pipelines-audio'

import { createBilingualTurnSplitter } from '@proj-airi/pipelines-audio'
import { nanoid } from 'nanoid'
import { defineStore, storeToRefs } from 'pinia'
import { computed, reactive, ref } from 'vue'

import { useLlmmarkerParser } from '../../composables/llm-marker-parser'
import { useBilingualCaptionBus } from '../../services/bilingual-captions'
import { useAiriCardStore } from '../modules'
import { useSettingsBilingualSubtitles } from '../settings/bilingual-subtitles'
import { useSpeechRuntimeStore } from '../speech-runtime'

export * from './notebook'
export * from './orchestrator'

export interface CharacterSparkNotifyReaction {
  id: string
  message: string
  createdAt: number
  sourceEventId?: string
  metadata?: Record<string, unknown>
}

interface ReactionBilingualState {
  /** Per-reaction snapshot splitter. Undefined when bilingual mode is off. */
  splitter: BilingualTurnSplitter
  /** Caption bus turn id, same value as the speech intent turnId. */
  turnId: string
  /** Spoken projection accumulated for the final reaction message. */
  spokenText: string
}

interface StreamingReactionState {
  reaction: CharacterSparkNotifyReaction
  intent: IntentHandle
  parser: ReturnType<ParserFactory>
  bilingual?: ReactionBilingualState
}

const MAX_REACTIONS = 200
type ParserFactory = typeof useLlmmarkerParser
let parserFactory: ParserFactory = useLlmmarkerParser

export function setCharacterLlmMarkerParserFactoryForTest(factory: ParserFactory | null) {
  parserFactory = factory ?? useLlmmarkerParser
}

export const useCharacterStore = defineStore('character', () => {
  const { activeCard, systemPrompt } = storeToRefs(useAiriCardStore())
  const bilingualSettings = useSettingsBilingualSubtitles()
  const bilingualCaptionBus = useBilingualCaptionBus()
  // Spark reactions interrupt earlier speech. Track active turn ids so the
  // previous reaction's caption line is cleared when a new one starts.
  const activeSparkTurnIds = new Set<string>()

  const name = computed(() => activeCard.value?.name ?? '')
  const ownerId = computed(() => activeCard.value?.name ?? 'default')

  const reactions = ref<CharacterSparkNotifyReaction[]>([])
  const streamingReactions = ref<Map<string, StreamingReactionState>>(new Map())
  const speechRuntimeStore = useSpeechRuntimeStore()

  /**
   * Splits one text block through the bilingual snapshot when enabled.
   * Returns spoken fragments for the marker parser and TTS; translation
   * fragments go straight to the caption bus.
   */
  function splitBilingualText(splitter: BilingualTurnSplitter | undefined, turnId: string, text: string): string {
    if (!splitter)
      return text

    let spoken = ''
    for (const event of splitter.consume(text)) {
      if (event.kind === 'spoken') {
        spoken += event.text
      }
      else {
        bilingualCaptionBus.ingestTranslation(turnId, {
          language: event.language,
          pairId: event.pairId,
          text: event.text,
        })
      }
    }
    return spoken
  }

  async function emitTextOutput(text: string) {
    // Plugin-emitted text can carry bilingual tags after a spark request
    // injected the format instruction. Give it a turn id so playback pairing
    // and the caption bus can handle it like a reaction.
    const snapshot = bilingualSettings.snapshot()
    const turnId = `spark:direct:${nanoid()}`
    const splitter = snapshot ? createBilingualTurnSplitter(snapshot) : undefined

    const intent = speechRuntimeStore.openIntent({
      turnId: splitter ? turnId : undefined,
      ownerId: ownerId.value,
      priority: 'normal',
      behavior: 'queue',
    })

    const parser = parserFactory({
      onLiteral: async (literal) => {
        if (literal)
          intent.writeLiteral(literal)
      },
      onSpecial: async (special) => {
        if (special)
          intent.writeSpecial(special)
      },
    })

    if (splitter) {
      const spoken = splitBilingualText(splitter, turnId, text)
      bilingualCaptionBus.ingestSpoken(turnId, spoken)
      await parser.consume(spoken)
    }
    else {
      await parser.consume(text)
    }
    await parser.end()

    if (splitter) {
      // An unclosed tag candidate stays out of TTS; publish any translations
      // whose audio never starts immediately, which is acceptable here
      // because direct output is not sentence-aligned upstream.
      bilingualCaptionBus.endTurn(turnId)
    }

    intent.writeFlush()
    intent.end()
  }

  function onSparkNotifyReactionStreamEvent(sparkEventId: string, chunk: string, options?: { metadata?: Record<string, unknown> }) {
    if (!streamingReactions.value.has(sparkEventId)) {
      const newReaction = reactive({
        id: nanoid(),
        message: '',
        createdAt: Date.now(),
        sourceEventId: sparkEventId,
        metadata: options?.metadata,
      }) satisfies CharacterSparkNotifyReaction

      // Read bilingual settings once per reaction. Mid-reaction settings
      // changes cannot leak tags into TTS or pair the wrong translation.
      const snapshot = bilingualSettings.snapshot()
      const turnId = `spark:${sparkEventId}`
      const bilingual = snapshot
        ? { splitter: createBilingualTurnSplitter(snapshot), turnId, spokenText: '' }
        : undefined
      if (bilingual) {
        for (const previousTurnId of activeSparkTurnIds)
          bilingualCaptionBus.resetTurn(previousTurnId)
        activeSparkTurnIds.clear()
        activeSparkTurnIds.add(turnId)
      }

      const intent = speechRuntimeStore.openIntent({
        turnId,
        intentId: turnId,
        ownerId: ownerId.value,
        priority: 'high',
        behavior: 'interrupt',
      })

      const parser = parserFactory({
        onLiteral: async (literal) => {
          if (literal)
            intent.writeLiteral(literal)
        },
        onSpecial: async (special) => {
          if (special)
            intent.writeSpecial(special)
        },
      })

      streamingReactions.value.set(sparkEventId, { reaction: newReaction, intent, parser, bilingual })
    }

    const state = streamingReactions.value.get(sparkEventId)!
    if (!state.bilingual) {
      state.reaction.message += chunk
      void state.parser.consume(chunk)
      return
    }

    // Spoken text feeds the marker parser and TTS, and becomes the stored
    // reaction message. Translation text goes to the caption bus only.
    const spoken = splitBilingualText(state.bilingual.splitter, state.bilingual.turnId, chunk)
    state.bilingual.spokenText += spoken
    state.reaction.message += spoken
    if (spoken)
      void state.parser.consume(spoken)
  }

  function onSparkNotifyReactionStreamEnd(sparkEventId: string, fullText: string, options?: { metadata?: Record<string, unknown> }) {
    const state = streamingReactions.value.get(sparkEventId)
    if (!state)
      return

    // With bilingual mode the raw full text still contains tags and
    // translations; persist the spoken projection instead. A truncated tag
    // candidate stays visible in the message but never reaches TTS.
    let persistedText = fullText
    if (state.bilingual) {
      const tail = state.bilingual.splitter.end()
        .map(event => event.text)
        .join('')
      state.bilingual.spokenText += tail
      persistedText = state.bilingual.spokenText
    }
    state.reaction.message = persistedText
    recordSparkNotifyReaction(sparkEventId, persistedText, { metadata: options?.metadata })

    void state.parser.end().then(() => {
      if (state.bilingual) {
        // Publish pairs whose audio never started (interrupted or rejected).
        bilingualCaptionBus.endTurn(state.bilingual.turnId)
        activeSparkTurnIds.delete(state.bilingual.turnId)
      }

      state.intent.writeFlush()
      state.intent.end()
      streamingReactions.value.delete(sparkEventId)
    })
  }

  function recordSparkNotifyReaction(sparkEventId: string, message: string, options?: { metadata?: Record<string, unknown> }) {
    const newReaction = {
      id: nanoid(),
      message,
      createdAt: Date.now(),
      sourceEventId: sparkEventId,
      metadata: options?.metadata,
    } satisfies CharacterSparkNotifyReaction

    reactions.value.push(newReaction)

    if (reactions.value.length > MAX_REACTIONS) {
      reactions.value.splice(0, reactions.value.length - MAX_REACTIONS)
    }
  }

  function clearReactions() {
    reactions.value = []
  }

  return {
    name,
    reactions,
    systemPrompt,

    recordSparkNotifyReaction,
    onSparkNotifyReactionStreamEvent,
    onSparkNotifyReactionStreamEnd,
    clearReactions,

    emitTextOutput,
  }
})
