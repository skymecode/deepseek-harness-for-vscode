import { describe, expect, it, vi } from 'vitest'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { registerMcpToolCatalog } from '../src/runtime/mcp-tool-catalog.js'

describe('MCP registry endpoint', () => {
  it('requires authentication, accepts only GET and exposes only tool metadata', () => {
    let handler!: (req: IncomingMessage, res: ServerResponse) => void
    const schemas = vi.fn(() => [{name:'mcp__a__b__echo',description:'echo',parameters:{secret:'not for UI'}},{name:'bash',description:'shell'}])
    const connection = { authorizeIndex: vi.fn(() => false) }
    registerMcpToolCatalog({ get: () => ({schemas}), webServer: { register: route => { handler = route.handler } } }, connection)
    const res = { writeHead: vi.fn(), end: vi.fn() }
    handler({method:'GET'} as IncomingMessage, res as unknown as ServerResponse)
    expect(schemas).not.toHaveBeenCalled()
    connection.authorizeIndex.mockReturnValue(true)
    handler({method:'POST'} as IncomingMessage, res as unknown as ServerResponse)
    expect(res.writeHead).toHaveBeenLastCalledWith(405, {allow:'GET'})
    handler({method:'GET'} as IncomingMessage, res as unknown as ServerResponse)
    expect(JSON.parse(res.end.mock.calls.at(-1)![0])).toEqual([{name:'mcp__a__b__echo',description:'echo'}])
    expect(res.writeHead).toHaveBeenLastCalledWith(200, expect.objectContaining({'cache-control':'no-store'}))
  })
})
