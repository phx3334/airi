import { describe, expect, it, vi } from 'vitest'

import { useCaptionItems } from './useCaptionItems'

describe('useCaptionItems', () => {
  it('expires each caption event without cancelling earlier events of the same type', () => {
    vi.useFakeTimers()

    try {
      const captions = useCaptionItems({ ttlMs: 1000 })

      captions.add({ type: 'caption-speaker', text: 'first' })
      vi.advanceTimersByTime(500)
      captions.add({ type: 'caption-speaker', text: 'second' })

      expect(captions.items.value.map(item => item.text)).toEqual(['first', 'second'])

      vi.advanceTimersByTime(500)

      expect(captions.items.value.map(item => item.text)).toEqual(['second'])

      vi.advanceTimersByTime(500)

      expect(captions.items.value).toEqual([])
    }
    finally {
      vi.useRealTimers()
    }
  })

  it('clears caption items of the matching type when an empty event arrives', () => {
    vi.useFakeTimers()

    try {
      const captions = useCaptionItems({ ttlMs: 1000 })

      captions.add({ type: 'caption-speaker', text: 'speaker' })
      captions.add({ type: 'caption-assistant', text: 'assistant' })
      captions.add({ type: 'caption-speaker', text: '' })

      expect(captions.items.value.map(item => item.text)).toEqual(['assistant'])

      vi.advanceTimersByTime(1000)

      expect(captions.items.value).toEqual([])
    }
    finally {
      vi.useRealTimers()
    }
  })

  // ROOT CAUSE:
  //
  // Translation text is generated before long speech finishes. Its own TTL
  // expired midway through playback and the line vanished while the spoken
  // captions stayed. Spoken playback events must refresh its countdown.
  it('keeps the translation line alive while spoken captions keep arriving', () => {
    vi.useFakeTimers()

    try {
      const captions = useCaptionItems({ ttlMs: 1000 })

      captions.add({ operation: 'replace', type: 'caption-assistant-translation', text: '你好' })
      vi.advanceTimersByTime(800)
      // Spoken sentence 1 plays 0.8s after the translation was generated.
      captions.add({ type: 'caption-assistant', text: 'Hello' })
      vi.advanceTimersByTime(800)
      expect(captions.items.value.map(item => item.type)).toContain('caption-assistant-translation')

      // Another spoken sentence refreshes it again.
      captions.add({ type: 'caption-assistant', text: 'world' })
      vi.advanceTimersByTime(800)
      expect(captions.items.value.map(item => item.type)).toContain('caption-assistant-translation')

      // It expires only after speech stops arriving for the full TTL.
      vi.advanceTimersByTime(1000)
      expect(captions.items.value.map(item => item.type)).not.toContain('caption-assistant-translation')
    }
    finally {
      vi.useRealTimers()
    }
  })

  // ROOT CAUSE:
  //
  // A single-language translation publishes a label badge, then a late
  // second language republishes without label (names are inline). Keeping the
  // old label showed a stale badge above the multi-language line.
  it('removes the label when a replace event carries no label', () => {
    vi.useFakeTimers()

    try {
      const captions = useCaptionItems({ ttlMs: 1000 })

      captions.add({ operation: 'replace', type: 'caption-assistant-translation', text: '你好', label: '中文' })
      expect(captions.items.value[0]?.label).toBe('中文')

      captions.add({ operation: 'replace', type: 'caption-assistant-translation', text: '中文 你好\n日本語 こんにちは' })
      expect(captions.items.value).toHaveLength(1)
      expect(captions.items.value[0]?.label).toBeUndefined()
      expect(captions.items.value[0]?.text).toBe('中文 你好\n日本語 こんにちは')
    }
    finally {
      vi.useRealTimers()
    }
  })

  // ROOT CAUSE:
  //
  // Streaming providers send a complete volatile sentence on each update.
  // The caption overlay appended every correction as a separate item.
  it('replaces volatile speaker captions without accumulating corrections', () => {
    vi.useFakeTimers()

    try {
      const captions = useCaptionItems({ ttlMs: 1000 })

      captions.add({ operation: 'replace', type: 'caption-speaker', text: '今天天气很号' })
      vi.advanceTimersByTime(500)
      captions.add({ operation: 'replace', type: 'caption-speaker', text: '今天天气很好' })

      expect(captions.items.value).toHaveLength(1)
      expect(captions.items.value[0]?.text).toBe('今天天气很好')

      vi.advanceTimersByTime(500)

      expect(captions.items.value).toHaveLength(1)

      vi.advanceTimersByTime(500)

      expect(captions.items.value).toEqual([])
    }
    finally {
      vi.useRealTimers()
    }
  })
})
