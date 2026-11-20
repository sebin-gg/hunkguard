// Proposed edits -> per-hunk review model. No disk writes here; the vscode
// layer applies accepted hunks via WorkspaceEdit (undoable).
import * as Diff from 'diff';

export interface Hunk {
  id: string;
  filePath: string;
  oldStart: number; // 1-based line in base content
  oldLines: number;
  lines: string[]; // raw diff lines: ' ', '-', '+'
  status: 'pending' | 'accepted' | 'rejected' | 'stale';
}

export interface Proposal {
  id: string;
  turnId: string;
  filePath: string;
  baseHash: string; // hash of base content the hunks were computed against
  eol: string; // dominant line ending of base content ('\n' or '\r\n')
  hunks: Hunk[];
  createdAt: number;
}

export interface EditOp { old_string: string; new_string: string }

export function hashContent(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

function splitLines(s: string): string[] {
  return s === '' ? [] : s.replace(/\r\n/g, '\n').split('\n');
}

export interface LocResult { start: number; count: number; indent: string }

function matchAt(lines: string[], i: number, needle: string[], mode: 'exact' | 'ws'): boolean {
  for (let j = 0; j < needle.length; j++) {
    const a = lines[i + j];
    if (a === undefined) return false;
    if (mode === 'exact' ? a !== needle[j] : a.trim() !== needle[j].trim()) return false;
  }
  return true;
}

// Locate old_string in content lines; exact match first, then whitespace-insensitive.
// Returns indent of the matched block so callers can re-apply it to new_string.
export function locateOldString(lines: string[], oldStr: string): LocResult | 'ambiguous' | null {
  const needle = splitLines(oldStr);
  if (needle.length === 0) return null;
  for (const mode of ['exact', 'ws'] as const) {
    const hits: number[] = [];
    outer: for (let i = 0; i + needle.length <= lines.length; i++) {
      if (!matchAt(lines, i, needle, mode)) continue;
      hits.push(i);
      if (hits.length > 1) return 'ambiguous';
    }
    if (hits.length === 1) {
      const m = lines[hits[0]].match(/^\s*/)?.[0] ?? '';
      return { start: hits[0], count: needle.length, indent: mode === 'ws' ? m : '' };
    }
  }
  return null;
}

// Fix new_string indentation when match was whitespace-insensitive:
// prepend the matched block's indent to lines that carry none.
function reindent(newStr: string, indent: string): string {
  if (!indent) return newStr;
  return newStr.split('\n').map(l => (l.trim() === '' || /^\s/.test(l) ? l : indent + l)).join('\n');
}

// Apply a list of edit ops to content sequentially. Returns final content or error.
export function applyEditOps(content: string, ops: EditOp[]): { content?: string; error?: string } {
  let working = content;
  for (const op of ops) {
    const loc = locateOldString(splitLines(working), op.old_string);
    if (loc === 'ambiguous') return { error: 'old_string matches multiple locations; include more context' };
    if (loc === null) return { error: 'old_string not found' };
    const lines = splitLines(working);
    const rep = splitLines(reindent(op.new_string, loc.indent));
    const before = lines.slice(0, loc.start).join('\n');
    const after = lines.slice(loc.start + loc.count).join('\n');
    working = (before ? before + '\n' : '') + rep.join('\n') + (after ? '\n' + after : '');
  }
  return { content: working };
}

// Build a Proposal for one file from base -> final content (already-edited).
// Line endings are normalized to \n for diffing; the dominant EOL is stored so
// applied results can be written back in the file's own convention.
export function proposalFromContents(
  proposalId: string, turnId: string, filePath: string,
  baseContent: string, finalContent: string, now = Date.now()
): Proposal | undefined {
  const eol = baseContent.includes('\r\n') ? '\r\n' : '\n';
  const b = baseContent.replace(/\r\n/g, '\n');
  const f = finalContent.replace(/\r\n/g, '\n');
  if (b === f) return undefined;
  const patch = Diff.structuredPatch(filePath, filePath, b, f, 'base', 'proposed', { context: 3 });
  const hunks: Hunk[] = patch.hunks.map((h, i) => ({
    id: `${proposalId}:${filePath}#${i}`,
    filePath,
    oldStart: h.oldStart,
    oldLines: h.oldLines,
    lines: h.lines,
    status: 'pending',
  }));
  if (!hunks.length) return undefined;
  return { id: proposalId, turnId, filePath, baseHash: hashContent(b), eol, hunks, createdAt: now };
}

// Build a Proposal for one file from a list of edit ops. Returns error string on failure.
export function buildProposal(
  proposalId: string, turnId: string, filePath: string,
  baseContent: string, ops: EditOp[], now = Date.now()
): { proposal?: Proposal; error?: string } {
  if (ops.length === 0) return { error: 'no edits supplied' };
  const r = applyEditOps(baseContent, ops);
  if (r.error) return { error: `${r.error} in ${filePath}` };
  const p = proposalFromContents(proposalId, turnId, filePath, baseContent, r.content!, now);
  if (!p) return { error: 'edits produced no change' };
  return { proposal: p };
}

// Apply only the hunks whose status is 'accepted' (or all non-rejected when acceptAll).
// Input/output use the file's own line-ending convention.
export function applySelectedHunks(baseContent: string, hunks: Hunk[]): { content?: string; staleHunkIds?: string[] } {
  const eol = baseContent.includes('\r\n') ? '\r\n' : '\n';
  const baseLines = splitLines(baseContent);
  const out: string[] = [];
  let cursor = 0; // 0-based index into baseLines
  const stale: string[] = [];
  const sorted = [...hunks].sort((a, b) => a.oldStart - b.oldStart);
  for (const h of sorted) {
    const startIdx = h.oldStart - 1;
    const delCount = h.oldLines;
    if (startIdx < cursor) { stale.push(h.id); continue; } // overlapping hunks unsupported
    // verify context: lines before startIdx that hunk expects (' ' or '-') must match
    const expectedOld: string[] = [];
    for (const l of h.lines) {
      if (l.startsWith('-') || l.startsWith(' ')) expectedOld.push(l.slice(1));
      else if (l.startsWith('+')) { /* insertion marker */ }
      else if (l.startsWith('\\')) { /* no newline marker */ }
    }
    // expectedOld covers the whole hunk range (context+deletions) = oldLines count
    const actualOld = baseLines.slice(startIdx, startIdx + delCount);
    if (expectedOld.length !== delCount || expectedOld.some((v, i) => v !== actualOld[i])) {
      stale.push(h.id);
      continue;
    }
    out.push(...baseLines.slice(cursor, startIdx));
    for (const l of h.lines) {
      if (l.startsWith('+')) out.push(l.slice(1));
      else if (l.startsWith(' ')) out.push(l.slice(1));
      // '-' lines dropped
    }
    cursor = startIdx + delCount;
  }
  out.push(...baseLines.slice(cursor));
  if (stale.length) return { staleHunkIds: stale };
  return { content: out.join(eol === '\r\n' ? '\r\n' : '\n') };
}

// Recompute hunk status after base content changed (staleness detection).
export function markStale(proposal: Proposal, currentBaseContent: string): boolean {
  if (hashContent(currentBaseContent.replace(/\r\n/g, '\n')) === proposal.baseHash) return false;
  for (const h of proposal.hunks) if (h.status === 'pending') h.status = 'stale';
  return true;
}
