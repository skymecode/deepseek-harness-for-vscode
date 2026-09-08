import { resizePrompt } from './composer-core.js'
import { components, elements, node, pastedImages, setPastedImages, t } from './context.js'
import type { PastedImage } from './types.js'

const IMAGE_MEDIA_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif'])

export async function addPastedImages(files: readonly File[]): Promise<void> {
  const accepted: PastedImage[] = []
  for (const file of files) {
    try {
      accepted.push(await fileToImageAttachment(file))
    } catch {
      // Unsupported or unreadable clipboard image; keep the rest.
    }
  }
  if (accepted.length === 0) return
  // Refuse early when the staged model is known to reject images, so a user
  // pasting a screenshot is told before the turn is spent on a doomed prompt.
  if (components.composerConfiguration.supportsImageInput() === false) {
    components.composerFeedback.show(t('modelRejectsImages'))
    return
  }
  setPastedImages([...pastedImages, ...accepted])
  renderImagePreviews()
  resizePrompt()
}

function fileToImageAttachment(file: File): Promise<PastedImage> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      const result = typeof reader.result === 'string' ? reader.result : ''
      const match = /^data:([^;,]+);base64,(.*)$/s.exec(result)
      if (!match || !IMAGE_MEDIA_TYPES.has(match[1]!) || match[2] === '') {
        reject(new Error('Unsupported image attachment'))
        return
      }
      const mediaType = match[1]!
      const data = match[2]!
      resolve({
        id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
        mediaType,
        data,
        ...(file.name === undefined || file.name === '' ? {} : { name: file.name }),
        previewUrl: result,
      })
    }
    reader.onerror = () => reject(reader.error ?? new Error('Failed to read image'))
    reader.readAsDataURL(file)
  })
}

function renderImagePreviews(): void {
  elements.imagePreviewList.classList.toggle('hidden', pastedImages.length === 0)
  const fragment = document.createDocumentFragment()
  for (const image of pastedImages) {
    const item = node('div', 'image-preview-item')
    item.dataset.imageId = image.id
    const button = node('button', 'image-preview-button') as HTMLButtonElement
    button.type = 'button'
    button.title = t('imagePreview')
    button.setAttribute('aria-label', t('imagePreview'))
    const thumb = node('img', 'image-preview-thumb') as HTMLImageElement
    thumb.src = image.previewUrl
    thumb.alt = image.name || t('imageAttachment')
    button.append(thumb)
    button.addEventListener('click', () => openImagePreview(image))
    const remove = node('button', 'image-preview-remove', '×') as HTMLButtonElement
    remove.type = 'button'
    remove.title = t('removeImageAttachment')
    remove.setAttribute('aria-label', t('removeImageAttachment'))
    remove.addEventListener('click', (event) => {
      event.stopPropagation()
      removePastedImage(image.id)
    })
    item.append(button, remove)
    fragment.append(item)
  }
  elements.imagePreviewList.replaceChildren(fragment)
}

function removePastedImage(id: string): void {
  setPastedImages(pastedImages.filter((image) => image.id !== id))
  renderImagePreviews()
  resizePrompt()
}

function openImagePreview(image: PastedImage): void {
  elements.imageLightboxImage.src = image.previewUrl
  elements.imageLightboxImage.alt = image.name || t('imageAttachment')
  elements.imageLightboxName.textContent = image.name || ''
  elements.imageLightbox.classList.remove('hidden')
  elements.imageLightboxClose.focus()
}

export function closeImagePreview(): void {
  elements.imageLightbox.classList.add('hidden')
  elements.imageLightboxImage.src = ''
  elements.imageLightboxImage.alt = ''
  elements.imageLightboxName.textContent = ''
}

export function clearPastedImages(): void {
  setPastedImages([])
  renderImagePreviews()
  closeImagePreview()
}
