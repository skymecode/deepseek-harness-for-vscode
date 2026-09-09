import { Context } from '@deepseek-ai/cordis'
import JsonlPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import { join } from 'node:path'
import { historyCompression } from './encoding.js'

export async function openHistoryStore(home: string) {
  const root = join(home, 'sessions')
  const compression = await historyCompression(root)
  const context = new Context()
  const fiber = context.plugin(JsonlPersistence, { root, compression })
  try { await fiber.await() }
  catch (error) { await fiber.dispose(); throw error }
  return { context, fiber, compression }
}
