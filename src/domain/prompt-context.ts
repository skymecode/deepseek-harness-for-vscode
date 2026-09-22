/** Raster image formats accepted by the Harness prompt wire. */
export type PromptImageMediaType = 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif'

/** Text context that is prepended to a Harness prompt. */
export interface TextPromptAttachment {
  readonly kind: 'selection' | 'file'
  readonly file?: string
  readonly text: string
  readonly startLine?: number
  readonly endLine?: number
  readonly tooLong?: boolean
}

/** Browser-submitted image bytes (base64) attached to a Harness prompt. */
export interface ImagePromptAttachment {
  readonly kind: 'image'
  readonly mediaType: PromptImageMediaType
  readonly data: string
  readonly name?: string
}

export interface FilePromptAttachment {
  readonly kind: 'binary-file'
  readonly file: string
  readonly data: string
}

export type PromptAttachment = TextPromptAttachment | ImagePromptAttachment | FilePromptAttachment
