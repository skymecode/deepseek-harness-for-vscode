// Test-only MCP server. No files, network access, credentials or external dependencies.
/* global process */
import { createInterface } from 'node:readline'
const lines = createInterface({ input: process.stdin })
lines.on('line', text => {
  const message = JSON.parse(text)
  if (message.id === undefined) return
  let result
  switch (message.method) {
    case 'initialize':
      result = { protocolVersion: '2025-11-25', capabilities: { tools: {} }, serverInfo: { name: 'fixture', version: '1' } }
      break
    case 'ping': result = {}; break
    case 'tools/list':
      result = { tools: [{ name: 'echo', description: 'Echo a synthetic marker.', inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'], additionalProperties: false } }] }
      break
    case 'tools/call':
      result = { content: [{ type: 'text', text: `MCP verified: ${message.params.arguments.text}` }] }
      break
    default:
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Method not found' } }) + '\n')
      return
  }
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }) + '\n')
})
