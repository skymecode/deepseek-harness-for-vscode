import { readFile, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'

const require = createRequire(import.meta.url)
const packageJsonPath = require.resolve('@deepseek-ai/dsh-llm-pi-ai/package.json')
const packageRoot = dirname(packageJsonPath)
const packageJson = JSON.parse(await readFile(packageJsonPath, 'utf8'))

const SUPPORTED_VERSIONS = ['0.1.1-rc.1', '0.1.1-rc.2', '0.1.2-alpha.4', '0.1.2-rc.1']

if (!SUPPORTED_VERSIONS.includes(packageJson.version)) {
  throw new Error(
    `Unsupported @deepseek-ai/dsh-llm-pi-ai version ${packageJson.version}; `
      + 'review whether the tool replay and connection probing patches are still required.',
  )
}

async function patchFile(relativePath, replacements) {
  const path = join(packageRoot, relativePath)
  let source = await readFile(path, 'utf8')
  let changed = false

  for (const { candidates, label } of replacements) {
    if (candidates.some(({ after }) => source.includes(after))) continue
    const matches = candidates.filter(({ before }) => source.split(before).length - 1 === 1)
    if (matches.length !== 1) {
      throw new Error(
        `Cannot apply ${label} to ${relativePath}: expected one matching source block across `
          + `${candidates.length} candidate(s), found ${matches.length}.`,
      )
    }
    source = source.replace(matches[0].before, matches[0].after)
    changed = true
  }

  if (changed) await writeFile(path, source, 'utf8')
  return changed
}

// DeepSeek-compatible relays require reasoning_content to be replayed on
// every assistant tool call. pi-ai normally strips thinking signatures when
// provider ids differ, so normalize only those tool-call messages to the
// current DeepSeek wire identity before dispatch.
const toolReplayNormalization = `
\t\t\t\t// DeepSeek-compatible relays require reasoning_content to be replayed on
\t\t\t\t// every assistant tool call. pi-ai normally strips thinking signatures
\t\t\t\t// when provider ids differ, so normalize only those tool-call messages
\t\t\t\t// to the current DeepSeek wire identity before dispatch.
\t\t\t\tconst context = model.api === "openai-completions" && model.compat?.thinkingFormat === "deepseek" ? {
\t\t\t\t\t...rawContext,
\t\t\t\t\tmessages: rawContext.messages.map((message) => {
\t\t\t\t\t\tif (message.role !== "assistant" || message.provider === model.provider || !message.content.some((block) => block.type === "toolCall")) return message;
\t\t\t\t\t\tconst content = message.content.filter((block) => block.type !== "thinking" || block.redacted !== true).map((block) => {
\t\t\t\t\t\t\tif (block.type === "thinking") return { type: "thinking", thinking: block.thinking, thinkingSignature: "reasoning_content" };
\t\t\t\t\t\t\tif (block.type === "text") return { type: "text", text: block.text };
\t\t\t\t\t\t\treturn { type: "toolCall", id: block.id, name: block.name, arguments: block.arguments };
\t\t\t\t\t\t});
\t\t\t\t\t\tif (!content.some((block) => block.type === "thinking")) content.unshift({ type: "thinking", thinking: "", thinkingSignature: "reasoning_content" });
\t\t\t\t\t\treturn { ...message, api: model.api, provider: model.provider, model: model.id, content };
\t\t\t\t\t})
\t\t\t\t} : rawContext;
`

// 0.1.1-rc.1 calls toPiContext in one line; 0.1.1-rc.2 spreads options with
// the watchdog signal and passes the route's image policy; 0.1.2-alpha.4
// moved the image payload into a second options object keyed with
// attachments/resolveImageAccess/maxRequestImageBytes/requestImagePolicy.
const RC1_CONTEXT_CALL = 'attachments === void 0 ? toPiContext(options, void 0, onReplayDegrade) : await toPiContext(options, attachments, onReplayDegrade, profile.maxRequestImageBytes);'
const RC2_CONTEXT_CALL = `attachments === void 0 ? toPiContext(options, void 0, onReplayDegrade) : await toPiContext({
\t\t\t\t\t...options,
\t\t\t\t\tsignal: watchdog.signal
\t\t\t\t}, attachments, onReplayDegrade, profile.maxRequestImageBytes, {
\t\t\t\t\tmaxPixels: profile.requestImagePixelBudget,
\t\t\t\t\tmaxBytes: profile.requestImageMaxBytes
\t\t\t\t});`
const ALPHA4_CONTEXT_CALL = `attachments === void 0 ? toPiContext(options, void 0, onReplayDegrade) : await toPiContext({
\t\t\t\t\t...options,
\t\t\t\t\tsignal: watchdog.signal
\t\t\t\t}, {
\t\t\t\t\tattachments,
\t\t\t\t\tresolveImageAccess: (ref) => this.config.resolveImageAccess?.(attachments, ref),
\t\t\t\t\tmaxRequestImageBytes: profile.maxRequestImageBytes,
\t\t\t\t\trequestImagePolicy: {
\t\t\t\t\t\tmaxPixels: profile.requestImagePixelBudget,
\t\t\t\t\t\tmaxBytes: profile.requestImageMaxBytes
\t\t\t\t\t}
\t\t\t\t}, onReplayDegrade);`

const runtimeChanged = await patchFile('lib/index.js', [
  {
    label: 'cross-provider DeepSeek tool replay',
    candidates: [ALPHA4_CONTEXT_CALL, RC2_CONTEXT_CALL, RC1_CONTEXT_CALL].map((call) => ({
      before: `\t\t\t\tconst context = ${call}\n\t\t\t\tconst iterator = toStreamChunks(snapshot.models.streamSimple(model, context, {`,
      after: `\t\t\t\tconst rawContext = ${call}${toolReplayNormalization}\t\t\t\tconst iterator = toStreamChunks(snapshot.models.streamSimple(model, context, {`,
    })),
  },
  {
    label: 'explicit endpoint connection probe',
    candidates: [{
      before: `\tif (request.provider !== void 0) {
\t\tconst installed = catalogModels(request.provider);`,
      after: `\t// A provider-only discovery is a catalog lookup. Supplying baseURL is an
\t// explicit connection probe: reach the endpoint and let storedApiKey resolve
\t// the route's write-only credential instead of returning a cached catalog.
\tif (request.provider !== void 0 && request.baseURL === void 0) {
\t\tconst installed = catalogModels(request.provider);`,
    }],
  },
])

if (runtimeChanged) {
  process.stdout.write('Patched @deepseek-ai/dsh-llm-pi-ai tool replay and connection probing.\n')
}
