// Headless E2E: MCP server + PendingStore + TrueForge session. Rehearses Task A
// without the VS Code UI. Run: node dist/headless.cjs <workspaceRoot> <prompt>
import * as fs from 'fs';
import * as path from 'path';
import { EditorMcpServer } from './mcp/editor-server';
import { PendingStore } from './editor/pending';
import { WorkspaceBridge, safeResolve, walkFiles, runShell } from './editor/workspace';
import { retrieve, formatContextBlock } from './context/retrieval';
import { applyEditOps, proposalFromContents } from './diff/proposal';

const ROOT = process.argv[2] ?? 'D:\\git\\flask';
const PROMPT = process.argv[3] ?? 'Task A rehearsal';
const TF = 'http://localhost:8790';
const MODEL = process.env.HG_MODEL ?? 'anthropic/deepseek-flash';

let store: PendingStore;
let currentTid = '';

const bridge: WorkspaceBridge = {
  root: ROOT,
  currentContent(rel) {
    const abs = safeResolve(ROOT, rel);
    return abs && fs.existsSync(abs) ? fs.readFileSync(abs, 'utf8') : '';
  },
  readFile(rel, maxLines) {
    const abs = safeResolve(ROOT, rel);
    if (!abs) return { content: '', truncated: false, path: rel };
    const content = store.overlayContent(abs);
    const lines = content.split('\n');
    return { content: lines.slice(0, maxLines).join('\n'), truncated: lines.length > maxLines, path: path.relative(ROOT, abs).replace(/\\/g, '/') };
  },
  search(query, maxResults) {
    const q = query.toLowerCase();
    const out: Array<{ path: string; line?: number; preview: string }> = [];
    for (const abs of walkFiles(ROOT, 3000)) {
      if (out.length >= maxResults) break;
      const rel = path.relative(ROOT, abs).replace(/\\/g, '/');
      if (rel.toLowerCase().includes(q)) { out.push({ path: rel, preview: '(filename)' }); continue; }
      let text = '';
      try { text = fs.readFileSync(abs, 'utf8'); } catch { continue; }
      if (text.length > 300000) text = text.slice(0, 300000);
      const idx = text.toLowerCase().indexOf(q);
      if (idx < 0) continue;
      const line = text.slice(0, idx).split('\n').length;
      out.push({ path: rel, line, preview: text.split('\n')[line - 1]?.trim().slice(0, 140) ?? '' });
    }
    return out;
  },
  propose(filePath, ops, turnId) {
    const abs = safeResolve(ROOT, filePath);
    if (!abs) return { error: 'path escapes workspace' };
    const base = store.overlayContent(abs);
    const r = applyEditOps(base, ops);
    if (r.error) return { error: `${r.error} in ${filePath}` };
    const p = proposalFromContents(`prop-${Date.now()}`, turnId, filePath, base, r.content!);
    if (!p) return { error: 'no change' };
    store.add(p);
    console.log(`[proposal] ${filePath}: ${p.hunks.length} hunk(s)`);
    return { proposalId: p.id };
  },
  runCommand(command, timeoutMs) { return runShell(command, ROOT, timeoutMs); },
};
store = new PendingStore(bridge);

async function api(method: string, p: string, body?: unknown) {
  const res = await fetch(`${TF}${p}`, { method, headers: body ? { 'Content-Type': 'application/json' } : undefined, body: body ? JSON.stringify(body) : undefined });
  const t = await res.text();
  try { return JSON.parse(t); } catch { return t; }
}

async function main() {
  const port = await mcp.start(8799);
  console.log(`MCP on ${port}, root=${ROOT}`);
  await api('PUT', '/api/v1/settings/mcp-servers', { manifest: { type: 'remote', name: 'hunkguard-editor', url: `http://127.0.0.1:${port}/mcp`, description: 'headless' } });

  const ctx = retrieve(ROOT, PROMPT, { budgetTokens: 8000, lowEnd: false });
  const ctxBlock = formatContextBlock(ctx, false);
  console.log(`[context] ${ctx.chunks.length} chunks ~${ctx.estimatedTokens} tok`);

  const sess = await api('POST', '/api/v1/sessions', { agent: { spec: {
    model: { name: MODEL },
    instructions: 'You are HunkGuard. Use workspace_search/read_file to explore, propose_write for edits (never write directly), run_command for tests (needs approval).',
    mcp_servers: [{ name: 'hunkguard-editor', enable_tools: ['@all'], require_approval_for_tools: ['propose_write', 'run_command'], preload_tools: ['workspace_search', 'list_files', 'read_file', 'propose_write', 'run_command'], preload: false }],
    config: { iteration_limit: 24 },
  } } });
  if (!sess?.data?.id) { console.log('SESSION CREATE FAILED:', JSON.stringify(sess).slice(0, 400)); await mcp.stop(); process.exit(2); }
  const sid = sess.data.id;
  console.log(`session=${sid}`);

  const turn = await api('POST', `/api/v1/sessions/${sid}/turns`, {
    input: [{ type: 'user.message', content: `${ctxBlock}\n\n---\n${PROMPT}` }],
    stream: false,
  });
  let tid = turn.data.id;
  currentTid = tid;
  console.log(`turn=${tid}`);

  let retries = 0;
  // poll events; on 429 resend "continue" as a fresh turn on same session
  for (let outer = 0; outer < 6; outer++) {
    const seen = new Set<string>();
    let finished = false;
    for (let i = 0; i < 240 && !finished; i++) {
      await new Promise(r => setTimeout(r, 2000));
      const ev = await api('GET', `/api/v1/sessions/${sid}/turns/${tid}/events`);
      const items = Array.isArray(ev.data) ? ev.data : (ev.data?.items ?? []);
      for (const e of items) {
        const key = e.id ?? JSON.stringify(e).slice(0, 60);
        if (seen.has(key)) continue;
        seen.add(key);
        if (e.type === 'model.message' && e.content) console.log(`[assistant] ${String(e.content).slice(0, 300)}`);
        if (e.type === 'model.message' && e.tool_calls) for (const c of e.tool_calls) console.log(`[toolcall] ${c.function?.name} ${String(c.function?.arguments).slice(0, 200)}`);
        if (e.type === 'tool.response') console.log(`[toolresult] ${String(e.content).slice(0, 200)}`);
        if (e.type === 'tool.approval_required') {
          for (const c of e.tool_calls ?? []) {
            console.log(`[APPROVAL NEEDED] ${c.name} ${c.tool_call_id}`);
            await api('POST', `/api/v1/sessions/${sid}/turns/${tid}/events`, { events: [{ type: 'user.tool_approval', thread_id: e.thread_id, tool_call_id: c.tool_call_id ?? c.id, approval: { status: 'allow' } }] });
            console.log('[approved]');
          }
        }
        if (e.type === 'turn.done') {
          const st = e.state?.status;
          console.log(`[done] status=${st}`);
          if (st === 'error' && /429|rate.?limit/i.test(String(e.state?.message ?? '')) && retries < 4) {
            retries++;
            console.log(`[429] waiting 65s then retrying (attempt ${retries})`);
            await new Promise(r => setTimeout(r, 65000));
            const t2 = await api('POST', `/api/v1/sessions/${sid}/turns`, { input: [{ type: 'user.message', content: 'Continue the task from where you left off.' }], stream: false });
            tid = t2.data.id;
            currentTid = tid;
            console.log(`retry turn=${tid}`);
            finished = true; // break inner, outer loop polls new tid
            break;
          }
          if (e.state?.output?.content) console.log(`[final] ${String(e.state.output.content).slice(0, 400)}`);
          await finish(sid, tid);
          return;
        }
        if (e.type === 'turn.error' || e.type === 'error') { console.log('[ERROR]', JSON.stringify(e).slice(0, 400)); await finish(sid, tid); return; }
      }
    }
    if (!finished) { console.log('TIMEOUT waiting for turn'); await finish(sid, tid); return; }
  }
  console.log('exhausted retries');
  await finish(sid, tid);
}

async function finish(sid: string, tid: string) {
  // Apply all pending hunks to disk (simulates user "accept all")
  const hunks = store.pendingHunks();
  console.log(`[hunks pending] ${hunks.length}`);
  const byProp = new Map<string, string[]>();
  for (const h of hunks) {
    if (h.status !== 'pending') continue;
    if (!byProp.has(h.proposalId)) byProp.set(h.proposalId, []);
    byProp.get(h.proposalId)!.push(h.id);
  }
  for (const [pid, ids] of byProp) {
    const { results, errors } = store.accept(ids);
    for (const e of errors) console.log('[accept-error]', e);
    for (const r of results) {
      fs.writeFileSync(r.filePath, r.newContent, 'utf8');
      console.log(`[applied] ${r.filePath} (${r.acceptedHunks.length} hunks)`);
    }
  }
  const turn = await api('GET', `/api/v1/sessions/${sid}/turns/${tid}`);
  console.log('[turn-state]', JSON.stringify(turn.data?.state ?? turn.data).slice(0, 300));
  await mcp.stop();
  process.exit(0);
}

const mcp = new EditorMcpServer(bridge, {
  turnId: () => currentTid,
  onProposal: (id, fp, n) => console.log(`[proposal-cb] ${fp} ${n} edits`),
});

main().catch(e => { console.error('FATAL', e); process.exit(1); });
