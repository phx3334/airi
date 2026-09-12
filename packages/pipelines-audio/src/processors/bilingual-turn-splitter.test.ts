import type { BilingualTurnEvent, BilingualTurnSnapshot } from './bilingual-turn-splitter'

import { describe, expect, it } from 'vitest'

import { createBilingualTurnSplitter } from './bilingual-turn-splitter'

const enZh: BilingualTurnSnapshot = { spokenLanguage: 'en', translationLanguages: ['zh'] }

/** Feeds the whole text through one splitter, including the end flush. */
function splitAll(text: string, snapshot: BilingualTurnSnapshot = enZh): BilingualTurnEvent[] {
  const splitter = createBilingualTurnSplitter(snapshot)
  return coalesce([...splitter.consume(text), ...splitter.end()])
}

/**
 * Merges adjacent fragments of the same track.
 *
 * The splitter emits fragments at chunk boundaries so TTS gets spoken text
 * without a delay. Fragment count is chunk-dependent; the stable contract is
 * the sequence of track segments and their pair ids.
 */
function coalesce(events: BilingualTurnEvent[]): BilingualTurnEvent[] {
  const result: BilingualTurnEvent[] = []
  for (const event of events) {
    const last = result.at(-1)
    if (last
      && last.kind === event.kind
      && (last.kind === 'spoken'
        || (event.kind === 'translation'
          && last.kind === 'translation'
          && last.language === event.language
          && last.pairId === event.pairId))) {
      last.text += event.text
    }
    else {
      result.push({ ...event })
    }
  }
  return result
}

/** Feeds one character at a time to prove chunk boundaries are irrelevant. */
function splitByCharacter(text: string, snapshot: BilingualTurnSnapshot = enZh): BilingualTurnEvent[] {
  const splitter = createBilingualTurnSplitter(snapshot)
  const events: BilingualTurnEvent[] = []
  for (const char of text)
    events.push(...splitter.consume(char))
  events.push(...splitter.end())
  return coalesce(events)
}

/** Feeds random-ish 1 to 3 character chunks. */
function splitBySmallChunks(text: string, snapshot: BilingualTurnSnapshot = enZh): BilingualTurnEvent[] {
  const splitter = createBilingualTurnSplitter(snapshot)
  const events: BilingualTurnEvent[] = []
  for (let index = 0; index < text.length;) {
    const size = (index % 3) + 1
    events.push(...splitter.consume(text.slice(index, index + size)))
    index += size
  }
  events.push(...splitter.end())
  return coalesce(events)
}

describe('createBilingualTurnSplitter', () => {
  it('splits alternating spoken and translation blocks', () => {
    const events = splitAll('[EN] Hello\n[ZH] 你好\n[EN] Bye\n[ZH] 再见')

    expect(events).toEqual([
      { kind: 'spoken', text: ' Hello\n' },
      { kind: 'translation', language: 'zh', pairId: 0, text: ' 你好\n' },
      { kind: 'spoken', text: ' Bye\n' },
      { kind: 'translation', language: 'zh', pairId: 1, text: ' 再见' },
    ])
  })

  it('produces identical events when tags span chunk boundaries', () => {
    const text = '[EN] Hi there\n[ZH] 嗨\n'
    const oneChunk = splitAll(text)

    expect(splitByCharacter(text)).toEqual(oneChunk)
    expect(splitBySmallChunks(text)).toEqual(oneChunk)
  })

  it('starts in spoken mode without an opening tag', () => {
    const events = splitAll('Hello first\n[ZH] 译文')

    expect(events).toEqual([
      { kind: 'spoken', text: 'Hello first\n' },
      { kind: 'translation', language: 'zh', pairId: 0, text: ' 译文' },
    ])
  })

  it('passes markdown links through as spoken text', () => {
    const events = splitAll('See [docs](https://example.com/x) now')

    expect(events).toEqual([
      { kind: 'spoken', text: 'See [docs](https://example.com/x) now' },
    ])
  })

  it('passes array indices and citations through as spoken text', () => {
    expect(splitAll('item [1] and [2] done')).toEqual([
      { kind: 'spoken', text: 'item [1] and [2] done' },
    ])
  })

  it('passes an unknown bracket tag through unchanged', () => {
    const events = splitAll('Hello [XX] world')

    expect(events).toEqual([
      { kind: 'spoken', text: 'Hello [XX] world' },
    ])
  })

  it('releases an unclosed tag at end of stream', () => {
    const events = splitAll('text cut off at [E')

    expect(events).toEqual([
      { kind: 'spoken', text: 'text cut off at [E' },
    ])
  })

  it('releases only the closing bracket for an unclosed complete tag', () => {
    const events = splitAll('wait [EN')

    expect(events).toEqual([
      { kind: 'spoken', text: 'wait [EN' },
    ])
  })

  it('keeps nested square brackets as ordinary text', () => {
    const events = splitAll('matrix [[0,1],[1,0]] ok')

    expect(events).toEqual([
      { kind: 'spoken', text: 'matrix [[0,1],[1,0]] ok' },
    ])
  })

  it('keeps CJK text, newlines, and whitespace', () => {
    const events = splitAll('[EN]  Hi \r\n\t[ZH]  你好  ')

    expect(events).toEqual([
      { kind: 'spoken', text: '  Hi \r\n\t' },
      { kind: 'translation', language: 'zh', pairId: 0, text: '  你好  ' },
    ])
  })

  it('groups consecutive spoken fragments into one pair', () => {
    const events = splitAll('[EN] one [EN] two\n[ZH] 一二')

    expect(events).toEqual([
      { kind: 'spoken', text: ' one  two\n' },
      { kind: 'translation', language: 'zh', pairId: 0, text: ' 一二' },
    ])
  })

  it('assigns one pair id to all translation blocks after a spoken block', () => {
    const snapshot: BilingualTurnSnapshot = { spokenLanguage: 'en', translationLanguages: ['zh', 'ja'] }
    const events = splitAll('[EN] Hello\n[ZH] 你好\n[JA] こんにちは\n[EN] Bye', snapshot)

    expect(events).toEqual([
      { kind: 'spoken', text: ' Hello\n' },
      { kind: 'translation', language: 'zh', pairId: 0, text: ' 你好\n' },
      { kind: 'translation', language: 'ja', pairId: 0, text: ' こんにちは\n' },
      { kind: 'spoken', text: ' Bye' },
    ])
  })

  it('emits only spoken events without configured translation languages', () => {
    const events = splitAll('[EN] Hello\n[ZH] 你好', { spokenLanguage: 'en', translationLanguages: [] })

    expect(events).toEqual([
      { kind: 'spoken', text: ' Hello\n[ZH] 你好' },
    ])
  })

  it('merges fragments when the same track tag repeats', () => {
    const events = splitAll('[EN] say [EN] again')

    expect(events).toEqual([
      { kind: 'spoken', text: ' say  again' },
    ])
  })

  it('does not mute the stream when the spoken language is empty', () => {
    const events = splitAll('[EN] still spoken', { spokenLanguage: '', translationLanguages: ['zh'] })

    expect(events).toEqual([
      { kind: 'spoken', text: '[EN] still spoken' },
    ])
  })

  it('returns no events for an empty chunk', () => {
    const splitter = createBilingualTurnSplitter(enZh)

    expect(splitter.consume('')).toEqual([])
    expect(splitter.end()).toEqual([])
  })

  it('flushes an unclosed candidate on the active translation track', () => {
    const events = splitByCharacter('[EN] Hello\n[ZH] ni\n[EN')

    expect(events).toEqual([
      { kind: 'spoken', text: ' Hello\n' },
      { kind: 'translation', language: 'zh', pairId: 0, text: ' ni\n[EN' },
    ])
  })

  it('treats lowercase tags as ordinary text', () => {
    const events = splitAll('[en] Hello')

    expect(events).toEqual([
      { kind: 'spoken', text: '[en] Hello' },
    ])
  })

  it('recovers after a bracket candidate fails and a real tag follows', () => {
    const events = splitByCharacter('[x][ZH] 译文')

    expect(events).toEqual([
      { kind: 'spoken', text: '[x]' },
      { kind: 'translation', language: 'zh', pairId: 0, text: ' 译文' },
    ])
  })
})
