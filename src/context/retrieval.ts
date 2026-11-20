// Context retrieval: @file/@symbol mentions + auto-ranked snippets inside a token budget.
// Low-end mode shrinks the budget hard for 4-8k context models.
import * as fs from 'fs';
import * as path from 'path';
import { walkFiles, isTextFile } from '../editor/workspace';

export interface RetrievedChunk {
  path: string;
  startLine: number;
  endLine: number;
  reason: string;
  text: string;
}

export interface RetrievalResult {
  chunks: RetrievedChunk[];
  estimatedTokens: number;
  filesConsidered: number;
  droppedForBudget: number;
}

const STOP = new Set(['the','a','an','and','or','of','to','in','for','on','with','is','are','be','as','at','by','that','this','it','from','add','new','make','update','change','fix','flask','app']);

function terms(text: string): string[] {
  return [...new Set(text.toLowerCase().replace(/[^a-z0-9_]+/g, ' ').split(/\s+/).filter(t => t.length > 2 && !STOP.has(t)))].slice(0, 24);
}

function estTokens(s: string): number { return Math.ceil(s.length / 4); }

// Extract explicit @path mentions (e.g. @src/flask/helpers.py or @helpers.py)
export function extractMentions(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/@([\w./\\-]+\.[a-zA-Z]{1,6})/g)) out.push(m[1]);
  return out;
}

// Extract @symbol mentions like @get_debug_flag (word after @ without extension)
export function extractSymbols(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/@([A-Za-z_][\w]*)/g)) {
    const w = m[1];
    if (!/\.[a-zA-Z]{1,6}$/.test(w)) out.push(w);
  }
  return out;
}

function scoreFile(relPath: string, content: string, kws: string[], symbols: string[]): number {
  const lp = relPath.toLowerCase();
  let score = 0;
  for (const k of kws) {
    if (lp.includes(k)) score += 8;
    const idx = content.toLowerCase().indexOf(k);
    if (idx >= 0) score += Math.max(1, 6 - Math.floor(idx / 20000));
  }
  for (const sym of symbols) {
    const re = new RegExp(`(def|class|function|const|let|var|async\\s+def|interface|type)\\s+${sym.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`);
    if (re.test(content)) score += 25;
    else if (content.includes(sym)) score += 6;
  }
  return score;
}

function bestWindow(lines: string[], keywords: string[], maxLines: number): { start: number; end: number; hits: number } {
  // sliding window of maxLines, score by keyword density
  if (lines.length <= maxLines) return { start: 0, end: lines.length, hits: keywords.length };
  let best = { start: 0, end: maxLines, hits: -1 };
  const win = Math.min(maxLines, 120);
  const step = Math.max(20, Math.floor(win / 3));
  const lower = lines.map(l => l.toLowerCase());
  for (let s = 0; s + win <= lines.length; s += step) {
    const slice = lower.slice(s, s + win);
    let hits = 0;
    for (const k of keywords) if (slice.some(l => l.includes(k))) hits++;
    if (hits > best.hits) best = { start: s, end: Math.min(lines.length, s + win), hits };
  }
  return { start: best.start, end: best.end, hits: best.hits };
}

export function retrieve(
  workspaceRoot: string,
  query: string,
  opts: { budgetTokens: number; maxFiles?: number; maxLinesPerFile?: number; lowEnd?: boolean }
): RetrievalResult {
  const maxFiles = opts.maxFiles ?? (opts.lowEnd ? 8 : 20);
  const maxLines = opts.maxLinesPerFile ?? (opts.lowEnd ? 80 : 160);
  const budget = opts.lowEnd ? Math.min(opts.budgetTokens, 4000) : opts.budgetTokens;
  const kws = terms(query);
  const syms = extractSymbols(query);
  const mentions = extractMentions(query);

  const files = walkFiles(workspaceRoot, 5000);
  const scored: Array<{ rel: string; abs: string; score: number; explicit: boolean }> = [];
  let considered = 0;
  for (const abs of files) {
    const rel = path.relative(workspaceRoot, abs).replace(/\\/g, '/');
    considered++;
    const isMention = mentions.some(m => rel.endsWith(m) || rel.includes(m));
    let content = '';
    try { content = fs.readFileSync(abs, 'utf8'); } catch { continue; }
    if (content.length > 400_000) content = content.slice(0, 400_000);
    let score = scoreFile(rel, content, kws, syms);
    if (isMention) score += 100;
    // filename-only cheap boost without full read already counted
    if (score > 0 || isMention) scored.push({ rel, abs, score: score + (isMention ? 0 : 0), explicit: isMention });
    if (scored.length > 400) break;
  }
  scored.sort((a, b) => b.score - a.score);
  const top = scored.slice(0, maxFiles);

  const chunks: RetrievedChunk[] = [];
  let used = 0;
  let dropped = 0;
  for (const f of top) {
    if (used >= budget) { dropped++; continue; }
    let content = '';
    try { content = fs.readFileSync(f.abs, 'utf8'); } catch { continue; }
    const lines = content.split('\n');
    const win = bestWindow(lines, [...kws, ...syms], maxLines);
    const text = lines.slice(win.start, win.end).join('\n');
    const tokens = estTokens(text);
    if (used + tokens > budget && chunks.length > 0) { dropped++; continue; }
    const reason = f.explicit ? 'explicit @mention'
      : syms.some(s => new RegExp(`\\b${s}\\b`).test(content)) ? 'symbol match'
      : 'keyword match';
    chunks.push({ path: f.rel, startLine: win.start + 1, endLine: win.end, reason, text });
    used += tokens;
  }
  return { chunks, estimatedTokens: used, filesConsidered: considered, droppedForBudget: dropped };
}

export function formatContextBlock(r: RetrievalResult, lowEnd: boolean): string {
  if (!r.chunks.length) return '';
  const parts = r.chunks.map(c =>
    `--- ${c.path}:${c.startLine}-${c.endLine} (${c.reason}) ---\n${c.text}`
  );
  const header = `[HunkGuard auto-context: ${r.chunks.length} file(s), ~${r.estimatedTokens} tokens${lowEnd ? ', low-end mode' : ''}${r.droppedForBudget ? `, ${r.droppedForBudget} dropped for budget` : ''}]`;
  return `${header}\n\n${parts.join('\n\n')}`;
}

// For inline-edit: focused context around the selection.
export function selectionContext(filePath: string, fullContent: string, selection: string, radiusLines = 30): string {
  const lines = fullContent.split('\n');
  const selLines = selection.split('\n');
  const idx = lines.findIndex((l, i) => lines.slice(i, i + selLines.length).join('\n') === selection);
  if (idx < 0) return selection;
  const s = Math.max(0, idx - radiusLines);
  const e = Math.min(lines.length, idx + selLines.length + radiusLines);
  return lines.slice(s, e).map((l, i) => `${s + i + 1}\t${l}`).join('\n');
}

export { isTextFile };
export type { RetrievedChunk as Chunk };
void fs; void path;
