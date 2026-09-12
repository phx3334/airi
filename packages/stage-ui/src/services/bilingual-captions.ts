import type { TokenTranslationPayload } from '@proj-airi/core-agent'
import type { CaptionChannelEvent } from '@proj-airi/stage-shared'

import { BILINGUAL_LANGUAGES } from '@proj-airi/pipelines-audio'
import { useBroadcastChannel } from '@vueuse/core'

import { createBilingualCaptionTracker } from '../composables/use-bilingual-captions'

/** Minimal playback item shape the tracker needs from either TTS transport. */
export interface BilingualCaptionPlaybackItem {
  /** Turn id stamped on REST pipeline items. */
  turnId?: string
  /** Intent id used to resolve streaming items that lack a turn id. */
  intentId: string
  text: string
}

export interface BilingualCaptionBus {
  /** Maps a streaming TTS intent (no item turnId) back to its chat turn. */
  mapIntentToTurn: (intentId: string, turnId: string) => void
  /** Stores a spoken fragment in the pair currently open for this turn. */
  ingestSpoken: (turnId: string, text: string) => void
  /** Stores a translated fragment and republishes when playback passed it. */
  ingestTranslation: (turnId: string, payload: TokenTranslationPayload) => void
  /** Matches one playback item and posts reached translation caption events. */
  routePlaybackItem: (item: BilingualCaptionPlaybackItem) => void
  /** Posts translations of pairs whose playback never started. */
  endTurn: (turnId: string) => void
  /** Clears one turn and posts the event that clears its caption line. */
  resetTurn: (turnId: string) => void
  /** Clears every turn and posts the event that clears the caption line. */
  resetAll: () => void
}

const labelsByCode = new Map<string, string>(BILINGUAL_LANGUAGES.map(language => [language.code, language.label]))

function createBus(): BilingualCaptionBus {
  const tracker = createBilingualCaptionTracker()
  const intentTurns = new Map<string, string>()

  // The broadcast channel is created lazily so non-renderer callers such as
  // unit tests never touch BroadcastChannel.
  let post: ((event: CaptionChannelEvent) => void) | undefined

  function emit(events: CaptionChannelEvent[]) {
    if (events.length === 0)
      return
    try {
      post ??= useBroadcastChannel<CaptionChannelEvent, CaptionChannelEvent>({ name: 'airi-caption-overlay' }).post
    }
    catch {
      return
    }
    for (const event of events) {
      try {
        post(event)
      }
      catch {
        // BroadcastChannel may be closed - don't break the producer.
      }
    }
  }

  return {
    mapIntentToTurn(intentId, turnId) {
      intentTurns.set(intentId, turnId)
    },
    ingestSpoken(turnId, text) {
      tracker.ingestSpoken(turnId, text)
    },
    ingestTranslation(turnId, payload) {
      const label = labelsByCode.get(payload.language) ?? payload.language
      emit(tracker.ingestTranslation(turnId, payload, label))
    },
    routePlaybackItem(item) {
      const turnId = item.turnId ?? intentTurns.get(item.intentId)
      if (!turnId)
        return
      emit(tracker.onPlaybackText(turnId, item.text))
    },
    endTurn(turnId) {
      emit(tracker.endTurn(turnId))
    },
    resetTurn(turnId) {
      emit(tracker.resetTurn(turnId))
    },
    resetAll() {
      intentTurns.clear()
      emit(tracker.resetAll())
    },
  }
}

let sharedBus: BilingualCaptionBus | undefined

/**
 * Returns the process-wide bilingual caption bus.
 *
 * Chat turns (Stage.vue) and spark-notify reactions (character store) both
 * speak through the same speech pipeline and caption channel, so one bus
 * owns the pair tracker and posts translation caption events.
 */
export function useBilingualCaptionBus(): BilingualCaptionBus {
  sharedBus ??= createBus()
  return sharedBus
}
