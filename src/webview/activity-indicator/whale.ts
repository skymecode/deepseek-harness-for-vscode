import { applyIcon, icon } from '../icons.js'

/** Decorative only: the parent status supplies its accessible description. */
export function createWhaleActivity(document: Document): HTMLElement {
  const whale = document.createElement('span')
  whale.className = 'activity-whale'
  whale.setAttribute('aria-hidden', 'true')
  applyIcon(whale, icon('whale', 20))
  const spout = document.createElement('span')
  spout.className = 'activity-whale-spout'
  const stream = document.createElement('i')
  stream.className = 'activity-whale-stream'
  spout.append(stream)
  for (let index = 0; index < 3; index += 1) {
    const drop = document.createElement('i')
    drop.className = 'activity-whale-drop'
    spout.append(drop)
  }
  whale.append(spout)
  return whale
}
