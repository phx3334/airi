import type { CaptionChannelEvent } from '@proj-airi/stage-shared'

/**
 * Matches translated fragments with TTS playback items for one or more turns.
 *
 * The splitter emits spoken fragments on the literal hook and translated
 * fragments on the translation hook, in wire order: spoken block N, then
 * translation block N. Playback items arrive later in FIFO order, but TTS
 * chunks one spoken block into several items. The tracker keeps one ordered
 * pair per spoken block and advances a pointer as items match pair prefixes.
 *
 * Translations can arrive after playback started. A pair therefore publishes
 * again when its translation text changes after playback reached it.
 */

export interface BilingualCaptionIngest {
  /** ISO 639-1 code from the translation hook payload. */
  language: string
  /** Pair identifier from the splitter. */
  pairId: number
  /** Fragment text from the translation hook. */
  text: string
}

export type BilingualCaptionOutEvent = CaptionChannelEvent

interface PairTranslation {
  /** Native language name used as the caption badge, for example `中文`. */
  label: string
  text: string
}

interface CaptionPair {
  id: number
  /** Raw spoken fragments assigned to this pair, in arrival order. */
  spokenRaw: string
  /** Spoken characters already covered by playback, in normalized space. */
  spokenConsumedLength: number
  /** Translation text per language, in display order. */
  translations: Map<string, PairTranslation>
  /** Playback reached this pair. */
  played: boolean
  /** Last event text published for this pair, to skip duplicate updates. */
  lastPublishedText: string | undefined
}

interface CaptionTurn {
  /** Pairs in playback order. */
  pairs: CaptionPair[]
  byId: Map<number, CaptionPair>
  /** Next wire block expected, mirroring the splitter state machine. */
  phase: 'spoken' | 'translation'
}

/** Maximum extra characters tolerated when TTS trims punctuation. */
const PREFIX_MISMATCH_TOLERANCE = 4

/** Collapses whitespace so chunk and provider boundaries do not affect matches. */
function normalize(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

interface NormalizedTranslationLine {
  language: string
  label: string
  text: string
}

/** Returns the non-empty normalized translation lines of one pair. */
function pairLines(pair: CaptionPair): NormalizedTranslationLine[] {
  const lines: NormalizedTranslationLine[] = []
  for (const [language, translation] of pair.translations) {
    const text = normalize(translation.text)
    if (text)
      lines.push({ language, label: translation.label, text })
  }
  return lines
}

/**
 * Builds one replace event for all pairs reached together.
 *
 * One playback item can cover several pairs when a streaming provider
 * synthesizes a whole turn as one item. Separate replace events overwrite
 * each other on the overlay, so all reached pairs merge into one event.
 */
function buildCombinedEvent(pairs: CaptionPair[]): BilingualCaptionOutEvent | undefined {
  const blocks = pairs
    .map(pair => ({ lines: pairLines(pair) }))
    .filter(block => block.lines.length > 0)
  if (blocks.length === 0)
    return undefined

  const languages = new Set<string>()
  for (const block of blocks) {
    for (const line of block.lines)
      languages.add(line.language)
  }
  const singleLanguage = languages.size === 1

  const textBlocks = blocks.map((block) => {
    if (singleLanguage)
      return block.lines.map(line => line.text).join('\n')
    // One badge cannot name several languages. Put the native name per line.
    return block.lines.map(line => `${line.label} ${line.text}`).join('\n')
  })

  const firstLine = blocks[0]?.lines[0]
  return {
    operation: 'replace',
    text: textBlocks.join('\n'),
    type: 'caption-assistant-translation',
    ...(singleLanguage && firstLine ? { label: firstLine.label } : {}),
  }
}

/** Creates the caption event payload for a pair when it has translations. */
function buildPairEvent(pair: CaptionPair): BilingualCaptionOutEvent | undefined {
  return buildCombinedEvent([pair])
}

export interface BilingualCaptionTracker {
  /** Stores a spoken fragment in the pair currently open for speech. */
  ingestSpoken: (turnId: string, text: string) => void
  /** Stores a translated fragment and republishes when playback passed it. */
  ingestTranslation: (turnId: string, payload: BilingualCaptionIngest, label: string) => BilingualCaptionOutEvent[]
  /** Matches one playback item and returns caption events for reached pairs. */
  onPlaybackText: (turnId: string, text: string) => BilingualCaptionOutEvent[]
  /**
   * Publishes translations of pairs whose playback never started, for
   * example a rejected TTS item. Called when the assistant response ends.
   */
  endTurn: (turnId: string) => BilingualCaptionOutEvent[]
  /** Clears one turn and returns the event that clears its caption line. */
  resetTurn: (turnId: string) => BilingualCaptionOutEvent[]
  /** Clears every turn and returns the event that clears the caption line. */
  resetAll: () => BilingualCaptionOutEvent[]
}

/**
 * Creates a playback-to-translation tracker.
 *
 * The instance is plain state. Keep it outside Vue reactivity because spoken
 * fragments arrive per token and reactive proxies would add overhead.
 */
export function createBilingualCaptionTracker(): BilingualCaptionTracker {
  const turns = new Map<string, CaptionTurn>()

  function ensureTurn(turnId: string): CaptionTurn {
    let turn = turns.get(turnId)
    if (!turn) {
      turn = {
        pairs: [],
        byId: new Map(),
        phase: 'spoken',
      }
      turns.set(turnId, turn)
    }
    return turn
  }

  function pairForSpoken(turn: CaptionTurn): CaptionPair {
    const last = turn.pairs.at(-1)
    if (last && turn.phase === 'spoken')
      return last

    const nextId = last ? last.id + 1 : 0
    const pair: CaptionPair = {
      id: nextId,
      spokenRaw: '',
      spokenConsumedLength: 0,
      translations: new Map(),
      played: false,
      lastPublishedText: undefined,
    }
    turn.pairs.push(pair)
    turn.byId.set(nextId, pair)
    turn.phase = 'spoken'
    return pair
  }

  function pairForTranslation(turn: CaptionTurn, pairId: number): CaptionPair {
    const existing = turn.byId.get(pairId)
    if (existing)
      return existing

    // A model can open with a translation block before speech. Fill the gap
    // in order so playback matching stays sequential.
    const pair: CaptionPair = {
      id: pairId,
      spokenRaw: '',
      spokenConsumedLength: 0,
      translations: new Map(),
      played: false,
      lastPublishedText: undefined,
    }
    turn.pairs.push(pair)
    turn.pairs.sort((a, b) => a.id - b.id)
    turn.byId.set(pairId, pair)
    return pair
  }

  function publishIfChanged(pair: CaptionPair): BilingualCaptionOutEvent[] {
    const event = buildPairEvent(pair)
    if (!event || event.text === pair.lastPublishedText)
      return []
    pair.lastPublishedText = event.text
    return [event]
  }

  function ingestSpoken(turnId: string, text: string) {
    if (!text)
      return
    const turn = ensureTurn(turnId)
    pairForSpoken(turn).spokenRaw += text
  }

  function ingestTranslation(turnId: string, payload: BilingualCaptionIngest, label: string): BilingualCaptionOutEvent[] {
    if (!payload.text)
      return []
    const turn = ensureTurn(turnId)
    const pair = pairForTranslation(turn, payload.pairId)
    turn.phase = 'translation'
    const current = pair.translations.get(payload.language)
    if (current)
      current.text += payload.text
    else
      pair.translations.set(payload.language, { label, text: payload.text })

    // Audio for this sentence may already play when its translation arrives.
    return pair.played ? publishIfChanged(pair) : []
  }

  type Alignment = 'inside' | 'covers' | 'tolerant' | 'none'

  function alignPlayed(played: string, remaining: string): Alignment {
    if (played.length === 0 || remaining.length === 0)
      return 'none'
    // The item sits inside the pair and more items for this pair can follow.
    if (remaining.startsWith(played))
      return 'inside'
    // The item contains the whole pair remainder and may reach later pairs.
    if (played.startsWith(remaining))
      return 'covers'

    // TTS providers can trim trailing punctuation. Accept a long shared
    // prefix with a small tail mismatch instead of stalling the pointer.
    const sharedLimit = Math.min(played.length, remaining.length)
    let shared = 0
    while (shared < sharedLimit && played[shared] === remaining[shared])
      shared += 1
    const tail = Math.max(played.length, remaining.length) - shared
    if (shared >= 8 && tail <= PREFIX_MISMATCH_TOLERANCE)
      return 'tolerant'
    return 'none'
  }

  function onPlaybackText(turnId: string, text: string): BilingualCaptionOutEvent[] {
    const turn = turns.get(turnId)
    if (!turn)
      return []

    let item = normalize(text)
    if (!item)
      return []

    // All pairs reached by one item publish together. A whole-turn buffered
    // item therefore shows all translations in one replace event.
    const newlyPlayed: CaptionPair[] = []
    let index = 0
    while (index < turn.pairs.length && item.length > 0) {
      const pair = turn.pairs[index]
      const spoken = normalize(pair.spokenRaw)
      if (spoken.length === 0) {
        index += 1
        continue
      }

      const remaining = spoken.slice(pair.spokenConsumedLength)
      if (remaining.length === 0) {
        index += 1
        continue
      }

      const alignment = alignPlayed(item, remaining)
      if (alignment === 'none')
        break

      // Consume the overlap in normalized character space. Chunker items and
      // provider sentences keep word order, so lengths stay comparable.
      if (alignment === 'tolerant') {
        // The provider trimmed trailing punctuation. Skip the unmatched tail
        // of the pair, otherwise the next item fails to match and every
        // later pair stops publishing.
        pair.spokenConsumedLength = spoken.length
        item = item.slice(remaining.length).trimStart()
      }
      else {
        const consumed = Math.min(item.length, remaining.length)
        pair.spokenConsumedLength += consumed
        // Pair boundaries align with word boundaries. Drop the inter-pair
        // space exposed by the slice so the next pair match starts first word.
        item = item.slice(consumed).trimStart()
        // A provider sentence can end before trailing punctuation. A short
        // punctuation-only tail would keep the pair open forever, so close it.
        if (item.length === 0 && /^[\s.,!?…。，！？、：:]+$/.test(remaining.slice(consumed)))
          pair.spokenConsumedLength = spoken.length
      }
      if (!pair.played) {
        pair.played = true
        newlyPlayed.push(pair)
      }
      if (pair.spokenConsumedLength >= spoken.length)
        index += 1
    }

    if (newlyPlayed.length === 0)
      return []

    const event = buildCombinedEvent(newlyPlayed)
    for (const pair of newlyPlayed)
      pair.lastPublishedText = buildPairEvent(pair)?.text

    return event ? [event] : []
  }

  function clearEvent(): BilingualCaptionOutEvent[] {
    return [{
      operation: 'replace',
      text: '',
      type: 'caption-assistant-translation',
    }]
  }

  function endTurn(turnId: string): BilingualCaptionOutEvent[] {
    const turn = turns.get(turnId)
    if (!turn)
      return []

    // Pairs without playback (rejected TTS, muted output) still show their
    // translation when the response ends. Merge them into one replace event.
    const unpublished = turn.pairs.filter(pair => !pair.played && pairLines(pair).length > 0)
    if (unpublished.length === 0)
      return []

    const event = buildCombinedEvent(unpublished)
    for (const pair of unpublished) {
      pair.played = true
      pair.lastPublishedText = buildPairEvent(pair)?.text
    }
    return event ? [event] : []
  }

  function resetTurn(turnId: string): BilingualCaptionOutEvent[] {
    if (!turns.delete(turnId))
      return []
    return clearEvent()
  }

  function resetAll(): BilingualCaptionOutEvent[] {
    if (turns.size === 0)
      return []
    turns.clear()
    return clearEvent()
  }

  return {
    ingestSpoken,
    ingestTranslation,
    onPlaybackText,
    endTurn,
    resetTurn,
    resetAll,
  }
}

/** Vue composable wrapper. Each component setup owns one tracker. */
export function useBilingualCaptions(): BilingualCaptionTracker {
  return createBilingualCaptionTracker()
}
