import type { BilingualTurnSnapshot } from '@proj-airi/pipelines-audio'

import { BILINGUAL_LANGUAGES } from '@proj-airi/pipelines-audio'
import { useLocalStorageManualReset } from '@proj-airi/stage-shared/composables'
import { defineStore } from 'pinia'

/** Languages the settings page shows. The wire tag is the uppercase code. */
export const bilingualLanguageOptions = BILINGUAL_LANGUAGES

/** Maximum number of translation subtitle lines. */
export const BILINGUAL_MAX_TRANSLATION_LANGUAGES = 2

/**
 * Builds the model instruction for one bilingual send.
 *
 * The instruction names only the tags from the snapshot. It teaches one tag
 * spelling so model variants such as `[JA-JP]` do not reach the splitter.
 *
 * @example
 * buildBilingualInstruction({ spokenLanguage: 'en', translationLanguages: ['zh'] })
 * // => 'Bilingual response format...'
 */
export function buildBilingualInstruction(snapshot: BilingualTurnSnapshot): string {
  const spokenTag = snapshot.spokenLanguage.toUpperCase()
  const translationTags = snapshot.translationLanguages.map(code => `[${code.toUpperCase()}]`)
  const allowedTags = [`[${spokenTag}]`, ...translationTags].join(', ')

  return [
    'Bilingual response format. Follow these rules:',
    `- Write each spoken sentence in the language of [${spokenTag}]. Text-to-speech reads only these blocks.`,
    `- After each spoken sentence, write its translation in ${translationTags.join(', ')} on the next line.`,
    '- Start each block with its language tag at the start of the line. '
    + `Allowed tags: ${allowedTags}.`,
    '- Use no other square brackets and no other language tags. Do not explain the format.',
    '- Keep <|...|> markers and tool-call syntax unchanged.',
    'Example:',
    '[EN] Hello, how are you?',
    '[ZH] 你好吗？',
  ].join('\n')
}

export const useSettingsBilingualSubtitles = defineStore('settings-bilingual-subtitles', () => {
  // Only the Stage host window reads these values, so this store stays out of
  // pinia-plugin-synced. The caption window receives translated text through
  // the caption broadcast channel.
  const enabled = useLocalStorageManualReset<boolean>('settings/bilingual/enabled', false)
  const spokenLanguage = useLocalStorageManualReset<string>('settings/bilingual/spoken-language', 'en')
  const translationLanguages = useLocalStorageManualReset<string[]>(
    'settings/bilingual/translation-languages',
    ['zh'],
  )

  /**
   * Returns the immutable snapshot for one send, or undefined when disabled.
   * Translation entries equal to the spoken language add no second track.
   */
  function snapshot(): BilingualTurnSnapshot | undefined {
    if (!enabled.value || !spokenLanguage.value)
      return undefined

    return {
      spokenLanguage: spokenLanguage.value,
      translationLanguages: translationLanguages.value.filter(code => code !== spokenLanguage.value),
    }
  }

  /** Returns the model instruction for the current settings, or undefined. */
  function instruction(): string | undefined {
    const current = snapshot()
    if (!current || current.translationLanguages.length === 0)
      return undefined
    return buildBilingualInstruction(current)
  }

  function resetState() {
    enabled.reset()
    spokenLanguage.reset()
    translationLanguages.reset()
  }

  return {
    enabled,
    spokenLanguage,
    translationLanguages,
    snapshot,
    instruction,
    resetState,
  }
})
