// MCP server (streamable HTTP) exposing editor operations to TrueForge.
// The extension host runs this on 127.0.0.1; TrueForge reaches it as a "remote" MCP.
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import type { WorkspaceBridge } from '../editor/workspace';

export interface McpToolHandlers {
  turnId: () => string;
  onProposal: (proposalId: string, filePath: string, hunkCount: number) => void;
}

function buildServer(bridge: WorkspaceBridge, h: McpToolHandlers): McpServer {
  const s = new McpServer({ name: 'hunkguard-editor', version: '0.1.0' });
  const text = (t: string) => ({ content: [{ type: 'text' as const, text: t }] });

  s.registerTool('workspace_search', {
    description: 'Search workspace file names and text content. Returns bounded matches with path:line and preview. Use this to discover relevant files.',
    inputSchema: {
      query: z.string().describe('Text or symbol to search for'),
      max_results: z.number().int().min(1).max(100).optional(),
    },
  }, async ({ query, max_results }) => {
    const res = bridge.search(query, max_results ?? 30);
    if (!res.length) return text(`No matches for "${query}".`);
    return text(res.map(r => `${r.path}${r.line ? ':' + r.line : ''}: ${r.preview}`).join('\n'));
  });

  s.registerTool('list_files', {
    description: 'List text files in the workspace (bounded). Useful for orientation.',
    inputSchema: { glob: z.string().optional().describe('Optional substring filter on path') },
  }, async ({ glob }) => {
    const { walkFiles } = await import('../editor/workspace');
    let files = walkFiles(bridge.root, 2000).map(f => f.slice(bridge.root.length + 1).replace(/\\/g, '/'));
    if (glob) files = files.filter(f => f.toLowerCase().includes(glob.toLowerCase()));
    return text(files.slice(0, 400).join('\n') + (files.length > 400 ? `\n... ${files.length - 400} more` : ''));
  });

  s.registerTool('read_file', {
    description: 'Read a workspace file with line numbers, bounded to max_lines. Shows pending proposed edits as overlay so you see the proposed state, not stale originals.',
    inputSchema: {
      path: z.string().describe('Workspace-relative or absolute path'),
      offset: z.number().int().min(1).optional(),
      max_lines: z.number().int().min(1).max(2000).optional(),
    },
  }, async ({ path: p, offset, max_lines }) => {
    const r = bridge.readFile(p, max_lines ?? 400);
    const start = Math.max(0, (offset ?? 1) - 1);
    const lines = r.content.split('\n');
    const slice = lines.slice(start, start + (max_lines ?? 400));
    const numbered = slice.map((l, i) => `${start + i + 1}\t${l}`).join('\n');
    return text(`${r.path}${r.truncated ? ' (truncated)' : ''}\n${numbered}`);
  });

  s.registerTool('propose_write', {
    description: 'Propose edits to workspace files WITHOUT writing to disk. Each edit replaces a unique old_string with new_string. The user reviews every hunk and accepts/rejects; nothing is written until accepted. To create a file, use old_string="" is NOT supported - instead propose edits that append via unique anchor, or use run_command only if user approves.',
    inputSchema: {
      edits: z.array(z.object({
        path: z.string().describe('Workspace-relative path'),
        old_string: z.string().describe('Exact text to replace - must span complete lines and match uniquely (indentation may differ)'),
        new_string: z.string().describe('Replacement text'),
      })).min(1).max(20),
    },
  }, async ({ edits }) => {
    // Group by path.
    const byPath = new Map<string, Array<{ old_string: string; new_string: string }>>();
    for (const e of edits) {
      if (!byPath.has(e.path)) byPath.set(e.path, []);
      byPath.get(e.path)!.push({ old_string: e.old_string, new_string: e.new_string });
    }
    const outs: string[] = [];
    for (const [p, ops] of byPath) {
      const r = bridge.propose(p, ops, h.turnId());
      if (r.error) outs.push(`${p}: ERROR ${r.error}`);
      else { h.onProposal(r.proposalId!, p, ops.length); outs.push(`${p}: proposed ${ops.length} edit(s), awaiting user review`); }
    }
    return text(outs.join('\n'));
  });

  s.registerTool('run_command', {
    description: 'Run a shell command in the workspace root (requires user approval). Has a timeout. Output is truncated. Do NOT use this to write files - use propose_write so changes go through diff review.',
    inputSchema: {
      command: z.string().describe('Shell command to run'),
      timeout_ms: z.number().int().min(1000).max(600000).optional(),
    },
  }, async ({ command, timeout_ms }) => {
    const r = await bridge.runCommand(command, timeout_ms ?? 120000);
    return text(`exit=${r.code ?? 'timeout'} timedOut=${r.timedOut}\n--- stdout ---\n${r.stdout}\n--- stderr ---\n${r.stderr}`);
  });

  return s;
}

export class EditorMcpServer {
  private transports = new Map<string, StreamableHTTPServerTransport>();
  private http: http.Server | null = null;
  port = 0;

  constructor(private bridge: WorkspaceBridge, private handlers: McpToolHandlers) {}

  async start(preferredPort = 0): Promise<number> {
    this.http = http.createServer(async (req, res) => {
      if (!req.url?.startsWith('/mcp')) { res.writeHead(404); res.end(); return; }
      const sid = req.headers['mcp-session-id'] as string | undefined;
      try {
        let t = sid ? this.transports.get(sid) : undefined;
        if (!t) {
          t = new StreamableHTTPServerTransport({
            sessionIdGenerator: () => randomUUID(),
            onsessioninitialized: (id) => { this.transports.set(id, t!); },
          });
          t.onclose = () => { if (t!.sessionId) this.transports.delete(t!.sessionId); };
          await buildServer(this.bridge, this.handlers).connect(t);
        }
        let body = '';
        for await (const c of req) body += c;
        await t.handleRequest(req, res, body ? JSON.parse(body) : undefined);
      } catch (e) {
        if (!res.headersSent) { res.writeHead(500); res.end(String(e)); }
      }
    });
    await new Promise<void>((resolve) => this.http!.listen(preferredPort, '127.0.0.1', resolve));
    const addr = this.http.address();
    this.port = typeof addr === 'object' && addr ? addr.port : preferredPort;
    return this.port;
  }

  async stop(): Promise<void> {
    for (const t of this.transports.values()) await t.close().catch(() => {});
    this.transports.clear();
    await new Promise<void>((r) => this.http?.close(() => r()) ?? r());
  }
}
