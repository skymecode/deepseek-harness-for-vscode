import { describe, expect, it } from 'vitest'
import {
  modelSpeed,
  pickAutoModel,
  supportsDeepReasoning,
  taskWeight,
  type ModelProfileInput,
} from '../src/domain/model-profile.js'

const models = (entries: readonly ModelProfileInput[]): readonly ModelProfileInput[] => entries

const flash = { id: 'deepseek-v4-flash', reasoning: { efforts: [{ id: 'off' }, { id: 'low' }, { id: 'high' }, { id: 'max' }] } }
const pro = { id: 'deepseek-v4-pro', reasoning: { efforts: [{ id: 'off' }, { id: 'low' }, { id: 'high' }, { id: 'max' }] } }
const balanced = { id: 'gpt-4o', reasoning: { efforts: [{ id: 'low' }, { id: 'high' }] } }
const shallow = { id: 'gpt-4o-mini', reasoning: { efforts: [{ id: 'low' }] } }

const light = { promptTokens: 200, attachmentCount: 0, historyTurns: 0 }
const normal = { promptTokens: 2_000, attachmentCount: 0, historyTurns: 1 }
const heavy = { promptTokens: 12_000, attachmentCount: 0, historyTurns: 0 }
const heavyAttachment = { promptTokens: 200, attachmentCount: 2, historyTurns: 0 }
const heavyHistory = { promptTokens: 200, attachmentCount: 0, historyTurns: 5 }

describe('modelSpeed', () => {
  it('classifies fast naming hints', () => {
    expect(modelSpeed('deepseek-v4-flash')).toBe('fast')
    expect(modelSpeed('claude-3-5-turbo')).toBe('fast')
    expect(modelSpeed('gemini-2.0-lite')).toBe('fast')
  })

  it('classifies powerful naming hints that also support deep reasoning', () => {
    expect(modelSpeed('deepseek-v4-pro', pro.reasoning?.efforts)).toBe('powerful')
    expect(modelSpeed('gpt-o1', pro.reasoning?.efforts)).toBe('powerful')
  })

  it('demotes a powerful-named model without deep reasoning to balanced', () => {
    expect(modelSpeed('deepseek-v4-pro', shallow.reasoning?.efforts)).toBe('balanced')
  })

  it('falls back to reasoning support when the name carries no hint', () => {
    expect(modelSpeed('gpt-4o', balanced.reasoning?.efforts)).toBe('powerful')
    expect(modelSpeed('gpt-4o', shallow.reasoning?.efforts)).toBe('balanced')
  })

  it('treats missing reasoning as shallow', () => {
    expect(modelSpeed('some-model')).toBe('balanced')
    expect(supportsDeepReasoning(undefined)).toBe(false)
  })
})

describe('taskWeight', () => {
  it('classifies by prompt size, attachments and history', () => {
    expect(taskWeight(light)).toBe('light')
    expect(taskWeight(normal)).toBe('normal')
    expect(taskWeight(heavy)).toBe('heavy')
    expect(taskWeight(heavyAttachment)).toBe('heavy')
    expect(taskWeight(heavyHistory)).toBe('heavy')
  })
})

describe('pickAutoModel', () => {
  it('picks the fast model for light tasks', () => {
    expect(pickAutoModel(models([flash, pro]), undefined, light)).toBe('deepseek-v4-flash')
  })

  it('keeps the current model when it already fits a light task', () => {
    expect(pickAutoModel(models([flash, pro]), 'deepseek-v4-flash', light)).toBe('deepseek-v4-flash')
  })

  it('escalates light-to-heavy to the deep-reasoning model', () => {
    expect(pickAutoModel(models([flash, pro]), 'deepseek-v4-flash', heavy)).toBe('deepseek-v4-pro')
  })

  it('escalates on attachments and long history too', () => {
    expect(pickAutoModel(models([flash, pro]), 'deepseek-v4-flash', heavyAttachment)).toBe('deepseek-v4-pro')
    expect(pickAutoModel(models([flash, pro]), 'deepseek-v4-flash', heavyHistory)).toBe('deepseek-v4-pro')
  })

  it('keeps the current selection for normal tasks (no churn)', () => {
    expect(pickAutoModel(models([flash, pro]), 'deepseek-v4-pro', normal)).toBe('deepseek-v4-pro')
    expect(pickAutoModel(models([flash, pro]), 'deepseek-v4-flash', normal)).toBe('deepseek-v4-flash')
  })

  it('falls back through tiers when the preferred one is missing', () => {
    // Only a shallow fast model and a balanced model: heavy task cannot land
    // on the shallow fast model and must fall back to balanced.
    const onlyShallow = models([shallow, balanced])
    expect(pickAutoModel(onlyShallow, 'gpt-4o-mini', heavy)).toBe('gpt-4o')
  })

  it('refuses to pick a non-deep-reasoning model for a heavy task', () => {
    const fastShallow = models([shallow])
    expect(pickAutoModel(fastShallow, 'gpt-4o-mini', heavy)).toBe('gpt-4o-mini')
  })

  it('returns the current model for an empty catalog', () => {
    expect(pickAutoModel(models([]), 'deepseek-v4-flash', heavy)).toBe('deepseek-v4-flash')
  })
})
