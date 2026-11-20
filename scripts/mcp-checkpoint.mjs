import http from 'node:http';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';

function buildServer() {
  const s = new McpServer({ name: 'hunkguard-editor', version: '0.0.1' });
  s.registerTool('editor_ping', {
    description: 'Health check for the editor MCP bridge.',
    inputSchema: { note: z.string().optional() }
  }, async ({ note }) => ({ content: [{ type: 'text', text: JSON.stringify({ ok: true, cwd: process.cwd(), note: note ?? null, ts: Date.now() }) }] }));
  return s;
}

const transports = {};
http.createServer(async (req, res) => {
  if (new URL(req.url, 'http://x').pathname !== '/mcp') { res.writeHead(404); res.end(); return; }
  const sid = req.headers['mcp-session-id'];
  try {
    let t = sid && transports[sid];
    if (!t) {
      t = new StreamableHTTPServerTransport({ sessionIdGenerator: () => crypto.randomUUID(), onsessioninitialized: (id) => { transports[id] = t; } });
      t.onclose = () => { if (t.sessionId) delete transports[t.sessionId]; };
      await buildServer().connect(t);
    }
    let body = '';
    for await (const c of req) body += c;
    await t.handleRequest(req, res, body ? JSON.parse(body) : undefined);
  } catch (e) { if (!res.headersSent) { res.writeHead(500); res.end(String(e)); } }
}).listen(8799, '127.0.0.1', () => console.log('mcp on 8799'));
