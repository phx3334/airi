/**
 * Streaming splitter for one bilingual assistant turn.
 *
 * The model emits the spoken language and one or more translations in one
 * text stream. Each block starts with an uppercase language tag in square
 * brackets:
 *
 * ```text
 * [EN] Hello, how are you?
 * [ZH] 你好吗？
 * ```
 *
 * The splitter separates spoken text from translation text before the TTS
 * fork. Tag characters never appear in output events. Brackets that are not
 * configured language tags (for example markdown links or array indices) pass
 * through without a delay longer than the longest configured opener.
 */

export interface BilingualLanguageEntry {
  /** ISO 639-1 code, for example `en` or `zh`. */
  code: string
  /**
   * Native language name shown in the settings page and on caption labels.
   */
  label: string
}

/**
 * Languages supported by the bilingual feature in its first version.
 *
 * The wire tag is always the uppercase ISO 639-1 code. The prompt teaches one
 * spelling only. Do not accept model-invented variants such as `JA-JP`.
 */
export const BILINGUAL_LANGUAGES = [
  { code: 'en', label: 'English' },
  { code: 'zh', label: '中文' },
  { code: 'ja', label: '日本語' },
  { code: 'ko', label: '한국어' },
  { code: 'es', label: 'Español' },
  { code: 'fr', label: 'Français' },
  { code: 'de', label: 'Deutsch' },
  { code: 'ru', label: 'Русский' },
  { code: 'pt', label: 'Português' },
  { code: 'it', label: 'Italiano' },
  { code: 'vi', label: 'Tiếng Việt' },
  { code: 'th', label: 'ไทย' },
] as const satisfies readonly BilingualLanguageEntry[]

export type BilingualLanguageCode = typeof BILINGUAL_LANGUAGES[number]['code']

/**
 * Immutable settings for one turn. Capture this object before the turn starts
 * so that settings changes do not affect an in-flight response.
 */
export interface BilingualTurnSnapshot {
  /** ISO 639-1 code of the language sent to TTS. */
  spokenLanguage: string
  /** ISO 639-1 codes shown as subtitle translations, in display order. */
  translationLanguages: string[]
}

export type BilingualTurnEvent
  = | {
    /** Text for TTS and the spoken-language bubble projection. */
    kind: 'spoken'
    text: string
  }
  | {
    /** Text for the translated subtitle track. */
    kind: 'translation'
    /** ISO 639-1 code of this translation language. */
    language: string
    /**
     * Pair identifier. A spoken block opens a pair after a translation block.
     * Translation blocks that follow the same spoken block share one id.
     */
    pairId: number
    text: string
  }

export interface BilingualTurnSplitter {
  /**
   * Feeds one LLM text chunk and returns the events it produced.
   *
   * A language tag can span multiple chunks. Do not assume chunk boundaries.
   */
  consume: (chunk: string) => BilingualTurnEvent[]
  /**
   * Flushes held bytes at turn end. An unclosed tag candidate is released as
   * ordinary text. Call this once when the LLM stream finishes.
   */
  end: () => BilingualTurnEvent[]
}

interface TagTarget {
  /** Full opener including brackets, for example `[EN]`. */
  opener: string
  language: string
  kind: 'spoken' | 'translation'
}

/** Returns the full bracket opener for an ISO 639-1 code. */
function openerForCode(code: string): string {
  return `[${code.toUpperCase()}]`
}

/** Character that follows a complete opener in markdown links. */
const MARKDOWN_LINK_FOLLOW = '('

/**
 * Creates a streaming splitter for one bilingual turn.
 *
 * @example
 * const splitter = createBilingualTurnSplitter({
 *   spokenLanguage: 'en',
 *   translationLanguages: ['zh'],
 * })
 * splitter.consume('[EN] Hello\n[ZH] 你好\n')
 * // => [
 * //   { kind: 'spoken', text: ' Hello\n' },
 * //   { kind: 'translation', language: 'zh', pairId: 0, text: ' 你好\n' },
 * // ]
 * splitter.end()
 * // => []
 */
export function createBilingualTurnSplitter(snapshot: BilingualTurnSnapshot): BilingualTurnSplitter {
  // Without a spoken language there is no wire format. Pass all text through
  // as spoken so a broken settings snapshot cannot mute a response.
  if (!snapshot.spokenLanguage) {
    return {
      consume(chunk) {
        return chunk.length > 0 ? [{ kind: 'spoken', text: chunk }] : []
      },
      end() {
        return []
      },
    }
  }

  const targets: TagTarget[] = []

  function addTarget(code: string, kind: TagTarget['kind']) {
    if (code.length === 0)
      return
    if (targets.some(target => target.language === code))
      return
    targets.push({ opener: openerForCode(code), language: code, kind })
  }

  addTarget(snapshot.spokenLanguage, 'spoken')
  for (const code of snapshot.translationLanguages) {
    // A translation in the spoken language adds no second track. The caller
    // filters this case, but the splitter keeps the guard for direct use.
    if (code !== snapshot.spokenLanguage)
      addTarget(code, 'translation')
  }

  const openers = targets.map(target => target.opener)
  const maxOpenerLength = openers.reduce((max, opener) => Math.max(max, opener.length), 0)

  // Held bytes that can still become an opener. Empty outside a candidate.
  let pending = ''
  let currentKind: TagTarget['kind'] = targets[0]?.kind ?? 'spoken'
  let currentLanguage = targets[0]?.language ?? snapshot.spokenLanguage
  let pairId = 0

  function isPrefixOfAnOpener(text: string): boolean {
    if (text.length > maxOpenerLength)
      return false
    // Case-sensitive: the prompt teaches the uppercase spelling. A lowercase
    // candidate such as `[en]` is ordinary text and releases immediately.
    return openers.some(opener => opener.startsWith(text))
  }

  function targetForOpener(text: string): TagTarget | undefined {
    return targets.find(target => target.opener === text)
  }

  function switchTarget(target: TagTarget) {
    if (target.kind === 'spoken') {
      // A new spoken block after a translation block opens the next pair.
      // Consecutive spoken blocks and repeated tags keep the current pair.
      if (currentKind === 'translation')
        pairId += 1
    }
    currentKind = target.kind
    currentLanguage = target.language
  }

  function makeEvent(text: string): BilingualTurnEvent {
    if (currentKind === 'spoken')
      return { kind: 'spoken', text }
    return { kind: 'translation', language: currentLanguage, pairId, text }
  }

  /**
   * Merges text into the event list. Adjacent events with the same kind,
   * language, and pair stay as one event.
   */
  function pushText(events: BilingualTurnEvent[], text: string) {
    if (text.length === 0)
      return
    const last = events.at(-1)
    if (last
      && last.kind === currentKind
      && (last.kind === 'spoken'
        || (last.kind === 'translation' && last.language === currentLanguage && last.pairId === pairId))) {
      last.text += text
      return
    }
    events.push(makeEvent(text))
  }

  /**
   * Releases a candidate that cannot become an opener. Keeps the longest
   * suffix that still matches an opener prefix, so a bracket inside the held
   * bytes gets another chance.
   */
  function releaseFailedCandidate(events: BilingualTurnEvent[], candidate: string) {
    for (let index = candidate.length - 1; index >= 1; index -= 1) {
      if (candidate[index] !== '[')
        continue
      const suffix = candidate.slice(index)
      if (isPrefixOfAnOpener(suffix)) {
        pushText(events, candidate.slice(0, index))
        pending = suffix
        return
      }
    }
    pushText(events, candidate)
    pending = ''
  }

  function consume(chunk: string): BilingualTurnEvent[] {
    const events: BilingualTurnEvent[] = []
    if (chunk.length === 0)
      return events

    for (const char of chunk) {
      if (pending.length > 0) {
        const candidate = pending + char

        if (isPrefixOfAnOpener(candidate)) {
          pending = candidate
          continue
        }

        // The held bytes are a complete opener. The new character is the
        // boundary character that decides tag versus markdown link.
        const completeTarget = targetForOpener(pending)
        if (completeTarget) {
          if (char === MARKDOWN_LINK_FOLLOW) {
            pushText(events, pending + char)
            pending = ''
            continue
          }
          pending = ''
          switchTarget(completeTarget)
          if (char === '[')
            pending = '['
          else
            pushText(events, char)
          continue
        }

        releaseFailedCandidate(events, candidate)
        continue
      }

      if (char === '[') {
        pending = '['
        continue
      }

      pushText(events, char)
    }

    return events
  }

  function end(): BilingualTurnEvent[] {
    const events: BilingualTurnEvent[] = []
    if (pending.length > 0) {
      // An unclosed opener candidate at turn end is ordinary text.
      const held = pending
      pending = ''
      pushText(events, held)
    }
    return events
  }

  return { consume, end }
}
