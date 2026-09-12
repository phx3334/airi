import { describe, expect, it } from 'vitest'

import { createBilingualCaptionTracker } from './use-bilingual-captions'

const TURN = 'turn-1'
const ZH = '中文'
const JA = '日本語'

/** Feeds the standard two-sentence EN/ZH turn into a fresh tracker. */
function seedStandardTurn() {
  const tracker = createBilingualCaptionTracker()
  tracker.ingestSpoken(TURN, ' Hello\n')
  tracker.ingestTranslation(TURN, { language: 'zh', pairId: 0, text: ' 你好\n' }, ZH)
  tracker.ingestSpoken(TURN, ' Bye\n')
  tracker.ingestTranslation(TURN, { language: 'zh', pairId: 1, text: ' 再见' }, ZH)
  return tracker
}

describe('createBilingualCaptionTracker', () => {
  it('publishes each translation when its spoken sentence starts playing', () => {
    const tracker = seedStandardTurn()

    expect(tracker.onPlaybackText(TURN, 'Hello')).toEqual([
      { operation: 'replace', text: '你好', type: 'caption-assistant-translation', label: ZH },
    ])
    expect(tracker.onPlaybackText(TURN, 'Bye')).toEqual([
      { operation: 'replace', text: '再见', type: 'caption-assistant-translation', label: ZH },
    ])
  })

  it('publishes nothing for an unknown turn', () => {
    const tracker = createBilingualCaptionTracker()
    expect(tracker.onPlaybackText('other-turn', 'Hello')).toEqual([])
  })

  it('marks a pair played on a partial chunk and stays quiet on the rest', () => {
    const tracker = seedStandardTurn()

    expect(tracker.onPlaybackText(TURN, 'Hel')).toHaveLength(1)
    // The remaining chunks of the same sentence replace nothing.
    expect(tracker.onPlaybackText(TURN, 'lo')).toEqual([])
    expect(tracker.onPlaybackText(TURN, 'Bye')).toEqual([
      expect.objectContaining({ text: '再见' }),
    ])
  })

  it('merges every pair covered by one whole-turn buffered item', () => {
    // ROOT CAUSE:
    //
    // seed-tts-2.0/seed-icl-2.0 bufferEntireSession synthesizes one turn as
    // one playback item. Emitting one replace event per pair made the overlay
    // keep only the last translation. All reached pairs must publish together.
    const tracker = seedStandardTurn()

    expect(tracker.onPlaybackText(TURN, 'Hello Bye')).toEqual([
      {
        operation: 'replace',
        text: '你好\n再见',
        type: 'caption-assistant-translation',
        label: ZH,
      },
    ])
  })

  it('publishes a late translation after playback already passed the pair', () => {
    const tracker = createBilingualCaptionTracker()
    tracker.ingestSpoken(TURN, ' Hello\n')

    // Audio starts before the model emitted the translation fragment.
    expect(tracker.onPlaybackText(TURN, 'Hello')).toEqual([])

    expect(tracker.ingestTranslation(TURN, { language: 'zh', pairId: 0, text: ' 你好' }, ZH)).toEqual([
      { operation: 'replace', text: '你好', type: 'caption-assistant-translation', label: ZH },
    ])
  })

  it('does not republish an unchanged translation on later fragments', () => {
    const tracker = createBilingualCaptionTracker()
    tracker.ingestSpoken(TURN, ' Hello\n')
    tracker.onPlaybackText(TURN, 'Hello')
    tracker.ingestTranslation(TURN, { language: 'zh', pairId: 0, text: ' 你' }, ZH)

    // Whitespace-only or identical final text must not churn the overlay.
    expect(tracker.ingestTranslation(TURN, { language: 'zh', pairId: 0, text: '好' }, ZH)).toHaveLength(1)
    expect(tracker.ingestTranslation(TURN, { language: 'zh', pairId: 0, text: '   ' }, ZH)).toEqual([])
  })

  it('puts inline labels on each line for two translation languages', () => {
    const tracker = createBilingualCaptionTracker()
    tracker.ingestSpoken(TURN, ' Hello\n')
    tracker.ingestTranslation(TURN, { language: 'zh', pairId: 0, text: ' 你好\n' }, ZH)
    tracker.ingestTranslation(TURN, { language: 'ja', pairId: 0, text: ' こんにちは' }, JA)

    const events = tracker.onPlaybackText(TURN, 'Hello')
    expect(events).toEqual([
      {
        operation: 'replace',
        text: `${ZH} 你好\n${JA} こんにちは`,
        type: 'caption-assistant-translation',
      },
    ])
    expect(events[0]?.label).toBeUndefined()
  })

  it('clears only the reset turn and keeps other turns intact', () => {
    const tracker = seedStandardTurn()
    tracker.ingestSpoken('turn-2', ' Hi')
    tracker.ingestTranslation('turn-2', { language: 'zh', pairId: 0, text: ' 嗨' }, ZH)

    expect(tracker.resetTurn(TURN)).toEqual([
      { operation: 'replace', text: '', type: 'caption-assistant-translation' },
    ])
    expect(tracker.onPlaybackText(TURN, 'Hello')).toEqual([])
    expect(tracker.onPlaybackText('turn-2', 'Hi')).toEqual([
      expect.objectContaining({ text: '嗨' }),
    ])
  })

  it('returns no clear event when the reset turn never existed', () => {
    const tracker = createBilingualCaptionTracker()
    expect(tracker.resetTurn('missing')).toEqual([])
  })

  it('tolerates trimmed punctuation from a TTS provider', () => {
    const tracker = createBilingualCaptionTracker()
    tracker.ingestSpoken(TURN, 'Hello there!')
    tracker.ingestTranslation(TURN, { language: 'zh', pairId: 0, text: '你好' }, ZH)

    // A provider sentence can drop trailing punctuation. The shared prefix is
    // long enough to align instead of stalling the pointer.
    expect(tracker.onPlaybackText(TURN, 'Hello there')).toEqual([
      expect.objectContaining({ text: '你好' }),
    ])
  })

  it('keeps matching later pairs after a punctuation-trimmed item', () => {
    // ROOT CAUSE:
    //
    // A provider sentence can end before trailing punctuation. The pair
    // stayed open with a `!` tail, so the next item failed to match and
    // every later pair stopped publishing.
    const tracker = createBilingualCaptionTracker()
    tracker.ingestSpoken(TURN, 'Hello there!')
    tracker.ingestTranslation(TURN, { language: 'zh', pairId: 0, text: '你好' }, ZH)
    tracker.ingestSpoken(TURN, ' Bye')
    tracker.ingestTranslation(TURN, { language: 'zh', pairId: 1, text: '再见' }, ZH)

    expect(tracker.onPlaybackText(TURN, 'Hello there')).toEqual([
      expect.objectContaining({ text: '你好' }),
    ])
    expect(tracker.onPlaybackText(TURN, 'Bye')).toEqual([
      expect.objectContaining({ text: '再见' }),
    ])
  })

  it('publishes unplayed pairs when the turn ends', () => {
    const tracker = seedStandardTurn()

    expect(tracker.endTurn(TURN)).toEqual([
      {
        operation: 'replace',
        text: '你好\n再见',
        type: 'caption-assistant-translation',
        label: ZH,
      },
    ])
    // A second endTurn call does not republish the same pairs.
    expect(tracker.endTurn(TURN)).toEqual([])
  })

  it('endTurn publishes nothing for an unknown turn', () => {
    const tracker = createBilingualCaptionTracker()
    expect(tracker.endTurn('missing')).toEqual([])
  })
})
