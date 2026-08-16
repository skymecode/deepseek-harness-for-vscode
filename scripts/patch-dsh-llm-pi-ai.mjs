import { readFile, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'

const require = createRequire(import.meta.url)
const packageJsonPath = require.resolve('@deepseek-ai/dsh-llm-pi-ai/package.json')
const packageRoot = dirname(packageJsonPath)
const packageJson = JSON.parse(await readFile(packageJsonPath, 'utf8'))

if (packageJson.version !== '0.1.0-rc.6') {
  throw new Error(
    `Unsupported @deepseek-ai/dsh-llm-pi-ai version ${packageJson.version}; `
      + 'review whether the supportsDeveloperRole compatibility patch is still required.',
  )
}

async function patchFile(relativePath, replacements) {
  const path = join(packageRoot, relativePath)
  let source = await readFile(path, 'utf8')
  let changed = false

  for (const { before, after, label } of replacements) {
    if (source.includes(after)) continue
    const occurrences = source.split(before).length - 1
    if (occurrences !== 1) {
      throw new Error(
        `Cannot apply ${label} to ${relativePath}: expected one matching source block, found ${occurrences}.`,
      )
    }
    source = source.replace(before, after)
    changed = true
  }

  if (changed) await writeFile(path, source, 'utf8')
  return changed
}

const runtimeChanged = await patchFile('lib/index.js', [
  {
    label: 'model compat resolution',
    before: `\tconst thinkingFormat = entry.compat?.thinkingFormat ?? route?.thinkingFormat;
\tconst supportsReasoningEffort = entry.compat?.supportsReasoningEffort ?? route?.supportsReasoningEffort;
\tif (thinkingFormat === void 0 && supportsReasoningEffort === void 0) return {};
\tif (api !== "openai-completions") {
\t\tif (entry.compat?.thinkingFormat !== void 0 || entry.compat?.supportsReasoningEffort !== void 0) invalid(provider, \`model "\${entry.id}" sets compat reasoning switches, but its api is "\${api}"; thinkingFormat and supportsReasoningEffort exist only on openai-completions\`);
\t\treturn {};
\t}
\treturn { compat: {
\t\t...base?.api === api ? base.compat : void 0,
\t\t...thinkingFormat === void 0 ? {} : { thinkingFormat },
\t\t...supportsReasoningEffort === void 0 ? {} : { supportsReasoningEffort }
\t} };`,
    after: `\tconst thinkingFormat = entry.compat?.thinkingFormat ?? route?.thinkingFormat;
\tconst supportsReasoningEffort = entry.compat?.supportsReasoningEffort ?? route?.supportsReasoningEffort;
\tconst supportsDeveloperRole = entry.compat?.supportsDeveloperRole ?? route?.supportsDeveloperRole;
\tif (thinkingFormat === void 0 && supportsReasoningEffort === void 0 && supportsDeveloperRole === void 0) return {};
\tif (api !== "openai-completions") {
\t\tif (entry.compat?.thinkingFormat !== void 0 || entry.compat?.supportsReasoningEffort !== void 0 || entry.compat?.supportsDeveloperRole !== void 0) invalid(provider, \`model "\${entry.id}" sets OpenAI Completions compat switches, but its api is "\${api}"; thinkingFormat, supportsReasoningEffort and supportsDeveloperRole exist only on openai-completions\`);
\t\treturn {};
\t}
\treturn { compat: {
\t\t...base?.api === api ? base.compat : void 0,
\t\t...thinkingFormat === void 0 ? {} : { thinkingFormat },
\t\t...supportsReasoningEffort === void 0 ? {} : { supportsReasoningEffort },
\t\t...supportsDeveloperRole === void 0 ? {} : { supportsDeveloperRole }
\t} };`,
  },
  {
    label: 'route compat detection',
    before: '\tconst routeCompatDefined = request.compat?.thinkingFormat !== void 0 || request.compat?.supportsReasoningEffort !== void 0;',
    after: '\tconst routeCompatDefined = request.compat?.thinkingFormat !== void 0 || request.compat?.supportsReasoningEffort !== void 0 || request.compat?.supportsDeveloperRole !== void 0;',
  },
  {
    label: 'route compat validation message',
    before: '\tif (routeCompatDefined && !models.some((model) => model.api === "openai-completions")) invalid(provider, "sets compat reasoning switches, but no model on the route speaks openai-completions; thinkingFormat and supportsReasoningEffort exist only on that protocol");',
    after: '\tif (routeCompatDefined && !models.some((model) => model.api === "openai-completions")) invalid(provider, "sets OpenAI Completions compat switches, but no model on the route speaks openai-completions; thinkingFormat, supportsReasoningEffort and supportsDeveloperRole exist only on that protocol");',
  },
  {
    label: 'runtime config schema',
    before: `const compatProfile = z.object({
\tthinkingFormat: z.union(SUPPORTED_THINKING_FORMATS),
\tsupportsReasoningEffort: z.boolean()
});`,
    after: `const compatProfile = z.object({
\tthinkingFormat: z.union(SUPPORTED_THINKING_FORMATS),
\tsupportsReasoningEffort: z.boolean(),
\tsupportsDeveloperRole: z.boolean()
});`,
  },
  {
    label: 'cross-provider DeepSeek tool replay',
    before: `\t\t\t\tconst context = attachments === void 0 ? toPiContext(options) : await toPiContext(options, attachments);
\t\t\t\tconst iterator = toStreamChunks(snapshot.models.streamSimple(model, context, {`,
    after: `\t\t\t\tconst rawContext = attachments === void 0 ? toPiContext(options) : await toPiContext(options, attachments);
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
\t\t\t\tconst iterator = toStreamChunks(snapshot.models.streamSimple(model, context, {`,
  },
  {
    label: 'explicit endpoint connection probe',
    before: `\tif (request.provider !== void 0) {
\t\tconst installed = catalogModels(request.provider);`,
    after: `\t// A provider-only discovery is a catalog lookup. Supplying baseURL is an
\t// explicit connection probe: reach the endpoint and let storedApiKey resolve
\t// the route's write-only credential instead of returning a cached catalog.
\tif (request.provider !== void 0 && request.baseURL === void 0) {
\t\tconst installed = catalogModels(request.provider);`,
  },
])

const typesChanged = await patchFile('lib/types/catalog.d.ts', [
  {
    label: 'compatibility profile type',
    before: `    /** Whether the endpoint accepts \`reasoning_effort\`; absent keeps the catalog entry's, then pi-ai's baseURL-derived guess. */
    supportsReasoningEffort?: boolean;
}`,
    after: `    /** Whether the endpoint accepts \`reasoning_effort\`; absent keeps the catalog entry's, then pi-ai's baseURL-derived guess. */
    supportsReasoningEffort?: boolean;
    /** Whether reasoning models accept the OpenAI \`developer\` role instead of \`system\`. */
    supportsDeveloperRole?: boolean;
}`,
  },
])

if (runtimeChanged || typesChanged) {
  process.stdout.write('Patched @deepseek-ai/dsh-llm-pi-ai compatibility and connection probing.\n')
}
