import { ConversationScrollController } from '../conversation-scroll/controller.js'
import { elements, setFollowStream, setInteractionArmed } from './context.js'

/** Wiring only: geometry/intent and reading anchors live in their own module. */
export const conversationScroll = new ConversationScrollController({
  viewport: elements.transcript,
  content: elements.transcriptContent,
  dock: elements.composerDock,
  onFollowChange: setFollowStream,
  onInteractionChange: setInteractionArmed,
})

window.addEventListener('pagehide', () => conversationScroll.dispose(), { once: true })
