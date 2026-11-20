import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { TrueForgeClient, TrueForgeError, AgentSpec } from './trueforge/client';
import { EditorMcpServer } from './mcp/editor-server';
import { WorkspaceBridge, safeResolve, walkFiles, runShell } from './editor/workspace';
import { PendingStore } from './editor/pending';
import { buildProposal, applyEditOps, proposalFromContents, Proposal } from './diff/proposal';
import { retrieve, formatContextBlock, selectionContext } from './context/retrieval';
import { HunkGuardPanel } from './panel/panel';

const AGENT_NAME = 'hunkguard-editor';
const INSTRUCTIONS = [
  'You are HunkGuard, an editor agent. You NEVER write files directly.',
  'Workflow: workspace_search / list_files to explore, read_file to inspect (reads show pending proposals as overlay), propose_write to suggest edits, run_command ONLY for verification commands like tests (requires user approval).',
  'propose_write edits must use exact unique old_string anchors copied from read_file output. Keep edits minimal and precise.',
  'After proposing, summarize what changed and wait for the user to accept hunks. Do not claim files were written until the user accepts.',
  'For new files: propose_write cannot create files; ask the user or use run_command with explicit approval.',
].join(' ');

interface SessionState {
  sessionId: string;
  model: string;
  turnId?: string;
  lastUserText?: string;
}

let client: TrueForgeClient;
let mcp: EditorMcpServer;
let store: PendingStore;
let panel: HunkGuardPanel;
let session: SessionState | null = null;
let currentTurnAbort: AbortController | null = null;
let lastTurnStatus = '';
let lastTurnError = '';
let appliedLog: Array<{ filePath: string; previousContent: string }> = [];

function cfg() {
  const c = vscode.workspace.getConfiguration('hunkguard');
  const lowEnd = c.get<boolean>('lowEndMode', false);
  return {
    url: c.get<string>('trueforgeUrl', 'http://localhost:8790'),
    model: c.get<string>('model', 'anthropic/deepseek-flash'),
    fallbacks: c.get<string[]>('fallbackModels', ['anthropic/gemini-flash', 'anthropic/gpt-luna']),
    lowEnd,
    budget: lowEnd ? Math.min(c.get<number>('contextBudgetTokens', 12000), 4000) : c.get<number>('contextBudgetTokens', 12000),
    maxRead: c.get<number>('maxReadLines', 400),
    cmdTimeout: c.get<number>('commandTimeoutMs', 120000),
  };
}

function bridge(): WorkspaceBridge {
  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!root) throw new Error('No workspace folder open.');
  const c = cfg();
  const b: WorkspaceBridge = {
    root,
    currentContent(rel) {
      const abs = safeResolve(root, rel);
      if (!abs || !fs.existsSync(abs)) return '';
      return fs.readFileSync(abs, 'utf8');
    },
    readFile(rel, maxLines) {
      const abs = safeResolve(root, rel);
      if (!abs) return { content: '', truncated: false, path: rel };
      const content = store.overlayContent(abs);
      const lines = content.split('\n');
      const truncated = lines.length > maxLines;
      return { content: lines.slice(0, maxLines).join('\n'), truncated, path: path.relative(root, abs).replace(/\\/g, '/') };
    },
    search(query, maxResults) {
      const q = query.toLowerCase();
      const out: Array<{ path: string; line?: number; preview: string }> = [];
      for (const abs of walkFiles(root, 3000)) {
        if (out.length >= maxResults) break;
        const rel = path.relative(root, abs).replace(/\\/g, '/');
        if (rel.toLowerCase().includes(q)) { out.push({ path: rel, preview: '(filename match)' }); continue; }
        let text: string;
        try { text = fs.readFileSync(abs, 'utf8'); } catch { continue; }
        if (text.length > 300_000) text = text.slice(0, 300_000);
        const idx = text.toLowerCase().indexOf(q);
        if (idx < 0) continue;
        const line = text.slice(0, idx).split('\n').length;
        const preview = text.split('\n')[line - 1]?.trim().slice(0, 160) ?? '';
        out.push({ path: rel, line, preview });
      }
      return out;
    },
    propose(filePath, ops, turnId) {
      const abs = safeResolve(root, filePath);
      if (!abs) return { error: 'path escapes workspace' };
      const base = store.overlayContent(abs);
      const results: string[] = [];
      let firstId = '';
      // group ops into ONE proposal per file for coherent hunks
      const { proposal, error } = buildAllOps(abs, filePath, base, ops, turnId);
      if (error) return { error };
      store.add(proposal!);
      firstId = proposal!.id;
      panel.post({ type: 'proposal', proposalId: firstId, filePath, hunks: proposal!.hunks.map(h => ({ id: h.id, header: hunkHeader(h), lines: h.lines, status: h.status })) });
      return { proposalId: firstId };
    },
    runCommand(command, timeoutMs) { return runShell(command, root, Math.min(timeoutMs, cfg().cmdTimeout)); },
  };
  return b;
}

// Multiple old/new ops on one file -> apply sequentially, diff base->final as one proposal.
function buildAllOps(abs: string, rel: string, base: string, ops: Array<{ old_string: string; new_string: string }>, turnId: string) {
  const r = applyEditOps(base, ops);
  if (r.error) return { error: `${r.error} in ${rel}` };
  const p = proposalFromContents(`prop-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, turnId, rel, base, r.content!);
  if (!p) return { error: `edits produced no change in ${rel}` };
  return { proposal: p };
}

function hunkHeader(h: { oldStart: number; oldLines: number }): string {
  return `@@ -${h.oldStart},${h.oldLines} @@`;
}

function agentSpec(model: string): AgentSpec {
  const c = cfg();
  return {
    model: { name: model },
    instructions: INSTRUCTIONS,
    mcp_servers: [{
      name: AGENT_NAME,
      enable_tools: ['@all'],
      require_approval_for_tools: ['propose_write', 'run_command'],
      preload_tools: ['workspace_search', 'list_files', 'read_file', 'propose_write', 'run_command'],
      preload: false,
    }],
    config: { iteration_limit: 24 },
  };
}

async function ensureSession(model?: string): Promise<SessionState> {
  if (session) return session;
  const m = model ?? cfg().model;
  const id = await client.createSession(agentSpec(m));
  session = { sessionId: id, model: m };
  panel.post({ type: 'session', sessionId: id, model: m });
  return session;
}

async function runTurn(userText: string, extraContext = '') {
  const c = cfg();
  const models = [c.model, ...c.fallbacks.filter(f => f !== c.model)];
  let lastErr: unknown = null;
  for (const model of models) {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const s = session && session.model === model ? session : await recreateSession(model);
        const text = extraContext ? `${extraContext}\n\n---\nUser request:\n${userText}` : userText;
        const turnId = await client.sendTurn(s.sessionId, text);
        s.turnId = turnId;
        s.lastUserText = userText;
        lastTurnStatus = '';
        lastTurnError = '';
        panel.post({ type: 'turnStart', turnId, model });
        await consumeEvents(s.sessionId, turnId);
        if (lastTurnStatus === 'done') return;
        if (lastTurnStatus === 'cancelled') return;
        throw new Error(lastTurnError || `turn ended with status "${lastTurnStatus || 'unknown'}"`);
      } catch (e) {
        lastErr = e;
        const msg = e instanceof Error ? e.message : String(e);
        panel.post({ type: 'modelFail', model, error: msg, attempt });
        const hay = `${msg} ${lastTurnError}`;
        const rateLimited = /429|rate.?limit/i.test(hay);
        if (rateLimited && attempt < 2) {
          panel.post({ type: 'info', message: `Rate limited — retrying ${model} in 65s (attempt ${attempt + 2}/3)` });
          await new Promise(r => setTimeout(r, 65000));
          continue;
        }
        break; // non-rate-limit error or retries exhausted -> next model
      }
    }
    // model exhausted: drop session so next model starts fresh
    if (session) { await client.deleteSession(session.sessionId).catch(() => {}); session = null; }
    await new Promise(r => setTimeout(r, 800));
  }
  panel.post({ type: 'error', message: `All models failed. Last error: ${lastErr instanceof Error ? lastErr.message : String(lastErr)}` });
}

async function recreateSession(model: string): Promise<SessionState> {
  if (session) { await client.deleteSession(session.sessionId).catch(() => {}); session = null; }
  return ensureSession(model);
}

async function consumeEvents(sessionId: string, turnId: string) {
  currentTurnAbort = new AbortController();
  try {
    for await (const ev of client.streamTurnEvents(sessionId, turnId, currentTurnAbort.signal)) {
      handleEvent(sessionId, turnId, ev);
      if (ev.type === 'turn.done' || ev.type === 'turn.error' || ev.type === 'turn.cancelled') break;
    }
  } catch (e) {
    if (!currentTurnAbort.signal.aborted) {
      panel.post({ type: 'error', message: `Event stream failed: ${e instanceof Error ? e.message : e}` });
    }
  } finally {
    currentTurnAbort = null;
    panel.post({ type: 'turnEnd' });
    refreshHunks();
  }
}

function handleEvent(sessionId: string, turnId: string, ev: any) {
  switch (ev.type) {
    case 'model.message': {
      const content = typeof ev.content === 'string' ? ev.content : '';
      if (content) panel.post({ type: 'assistant', text: content });
      const calls = ev.tool_calls as Array<{ function?: { name?: string; arguments?: string } }> | undefined;
      if (calls?.length) {
        for (const c of calls) {
          panel.post({ type: 'toolCall', name: c.function?.name ?? '?', args: safeArgs(c.function?.arguments) });
        }
      }
      break;
    }
    case 'tool.response': {
      panel.post({ type: 'toolResult', name: 'tool', text: String(ev.content ?? '').slice(0, 2000) });
      break;
    }
    case 'tool.approval_required': {
      const calls = (ev.tool_calls ?? []) as Array<{ tool_call_id?: string; id?: string; name?: string }>;
      for (const c of calls) {
        panel.post({ type: 'approval', threadId: ev.thread_id, toolCallId: c.tool_call_id ?? c.id, name: c.name ?? '?' });
      }
      break;
    }
    case 'turn.done': {
      const st = ev.state?.status;
      lastTurnStatus = st ?? 'done';
      lastTurnError = String(ev.state?.message ?? ev.state?.output?.content ?? '');
      panel.post({ type: 'done', status: st ?? 'done' });
      break;
    }
    case 'turn.error': case 'error': {
      panel.post({ type: 'error', message: JSON.stringify(ev).slice(0, 500) });
      break;
    }
    default:
      panel.post({ type: 'event', eventType: ev.type });
  }
}

function safeArgs(a?: string): string {
  try { const o = JSON.parse(a ?? '{}'); return JSON.stringify(o).slice(0, 300); } catch { return (a ?? '').slice(0, 300); }
}

function refreshHunks() {
  const hunks = store.pendingHunks();
  panel.post({ type: 'hunks', hunks: hunks.map(h => ({ id: h.id, filePath: h.filePath, proposalId: h.proposalId, status: h.status, header: `@@ -${h.oldStart},${h.oldLines} @@`, preview: h.lines.slice(0, 40).join('\n') })) });
}

async function applyAccepted(results: Array<{ filePath: string; newContent: string }>) {
  const edit = new vscode.WorkspaceEdit();
  for (const r of results) {
    const uri = vscode.Uri.file(r.filePath);
    const doc = await vscode.workspace.openTextDocument(uri);
    const prev = doc.getText();
    appliedLog.push({ filePath: r.filePath, previousContent: prev });
    const full = new vscode.Range(0, 0, doc.lineCount, 0);
    edit.replace(uri, full, r.newContent);
  }
  await vscode.workspace.applyEdit(edit);
}

async function acceptHunks(hunkIds: string[]) {
  const { results, errors } = store.accept(hunkIds);
  if (results.length) await applyAccepted(results);
  for (const e of errors) panel.post({ type: 'error', message: e });
  refreshHunks();
}

async function rejectHunks(hunkIds: string[]) {
  store.reject(hunkIds);
  refreshHunks();
}

async function undoLast() {
  const last = appliedLog.pop();
  if (!last) { panel.post({ type: 'error', message: 'Nothing to undo' }); return; }
  const uri = vscode.Uri.file(last.filePath);
  const doc = await vscode.workspace.openTextDocument(uri);
  const edit = new vscode.WorkspaceEdit();
  edit.replace(uri, new vscode.Range(0, 0, doc.lineCount, 0), last.previousContent);
  await vscode.workspace.applyEdit(edit);
  panel.post({ type: 'info', message: `Undid last applied edit in ${path.basename(last.filePath)}` });
}

async function stopTurn() {
  if (session?.turnId) {
    await client.cancelSession(session.sessionId).catch(() => {});
    store.discardTurn(session.turnId);
  }
  currentTurnAbort?.abort();
  panel.post({ type: 'stopped' });
  refreshHunks();
}

async function sendPrompt(text: string) {
  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!root) { panel.post({ type: 'error', message: 'Open a folder first' }); return; }
  if (!client) { panel.post({ type: 'error', message: 'HunkGuard not initialized' }); return; }
  panel.post({ type: 'user', text });
  const c = cfg();
  const r = retrieve(root, text, { budgetTokens: c.budget, lowEnd: c.lowEnd });
  const ctxBlock = formatContextBlock(r, c.lowEnd);
  panel.post({ type: 'context', files: r.chunks.map(ch => ({ path: ch.path, reason: ch.reason, lines: `${ch.startLine}-${ch.endLine}` })), tokens: r.estimatedTokens, lowEnd: c.lowEnd });
  await runTurn(text, ctxBlock);
}

async function editSelection() {
  const ed = vscode.window.activeTextEditor;
  if (!ed || ed.selection.isEmpty) { vscode.window.showInformationMessage('Select code first'); return; }
  const doc = ed.document;
  const sel = doc.getText(ed.selection);
  const rel = vscode.workspace.asRelativePath(doc.uri);
  const instruction = await vscode.window.showInputBox({
    prompt: `Instruction for selection in ${rel}`,
    placeHolder: 'e.g. treat "off" and "n" as false, case-insensitively',
  });
  if (!instruction) return;
  const ctx = `[Inline edit]\nFile: ${rel}\nSelected lines:\n${selectionContext(rel, doc.getText(), sel, 40)}\n\nInstruction: ${instruction}`;
  panel.reveal();
  await sendPrompt(`${ctx}`);
}

export async function activate(context: vscode.ExtensionContext) {
  const c = cfg();
  client = new TrueForgeClient(c.url);

  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd();
  store = new PendingStore(bridge());

  panel = new HunkGuardPanel(context.extensionUri);
  context.subscriptions.push(panel);

  mcp = new EditorMcpServer(bridge(), {
    turnId: () => session?.turnId ?? '',
    onProposal: (id, fp, n) => panel.post({ type: 'info', message: `Proposal ${id} on ${fp} (${n} edits)` }),
  });
  const port = await mcp.start(0);
  context.subscriptions.push({ dispose: () => mcp.stop() });

  // Register MCP endpoint with local TrueForge (requires OUTBOUND_URL_ALLOWED_HOSTS to include 127.0.0.1/localhost).
  try {
    await client.registerMcpServer(AGENT_NAME, `http://127.0.0.1:${port}/mcp`, 'HunkGuard editor bridge: search/read/propose/run tools');
  } catch (e) {
    panel.post({ type: 'error', message: `Could not register MCP server with TrueForge: ${e instanceof Error ? e.message : e}. Restart TrueForge with OUTBOUND_URL_ALLOWED_HOSTS=["127.0.0.1","localhost"].` });
  }

  panel.onMessage(async (msg) => {
    const m = msg as { type: string; text?: string; threadId?: string; toolCallId?: string; reason?: string; ids?: string[] };
    switch (m.type) {
      case 'prompt': await sendPrompt(m.text ?? ''); break;
      case 'stop': await stopTurn(); break;
      case 'approve': {
        if (session?.turnId && m.threadId && m.toolCallId) await client.respondApproval(session.sessionId, session.turnId, m.threadId, m.toolCallId, true);
        break;
      }
      case 'deny': {
        if (session?.turnId && m.threadId && m.toolCallId) await client.respondApproval(session.sessionId, session.turnId, m.threadId, m.toolCallId, false, m.reason);
        break;
      }
      case 'hunkAccept': await acceptHunks(m.ids ?? []); break;
      case 'hunkReject': await rejectHunks(m.ids ?? []); break;
      case 'acceptAll': {
        const ids = store.pendingHunks().filter(h => h.status === 'pending').map(h => h.id);
        await acceptHunks(ids);
        break;
      }
      case 'rejectAll': {
        const ids = store.pendingHunks().filter(h => h.status === 'pending' || h.status === 'stale').map(h => h.id);
        await rejectHunks(ids);
        break;
      }
      case 'undo': await undoLast(); break;
      case 'newSession': {
        if (session) await client.deleteSession(session.sessionId).catch(() => {});
        session = null;
        panel.post({ type: 'info', message: 'Session reset' });
        break;
      }
    }
  });

  context.subscriptions.push(
    vscode.commands.registerCommand('hunkguard.openPanel', () => panel.reveal()),
    vscode.commands.registerCommand('hunkguard.editSelection', editSelection),
    vscode.commands.registerCommand('hunkguard.stop', stopTurn),
    vscode.commands.registerCommand('hunkguard.acceptAll', async () => {
      const ids = store.pendingHunks().filter(h => h.status === 'pending').map(h => h.id);
      await acceptHunks(ids);
    }),
    vscode.commands.registerCommand('hunkguard.rejectAll', async () => {
      const ids = store.pendingHunks().filter(h => h.status === 'pending' || h.status === 'stale').map(h => h.id);
      await rejectHunks(ids);
    }),
    vscode.commands.registerCommand('hunkguard.undoLast', undoLast),
  );

  // TrueForge health indicator in status bar
  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  status.text = '$(shield) HunkGuard';
  status.tooltip = 'Local TrueForge agent backend';
  status.show();
  client.health().then(ok => { status.text = ok ? '$(shield) HunkGuard ✓' : '$(shield) HunkGuard ✗ (TrueForge offline)'; });
  context.subscriptions.push(status);
}

export function deactivate() {
  mcp?.stop();
}
