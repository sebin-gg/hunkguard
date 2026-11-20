// Pending proposal store: overlay reads + per-hunk accept/reject state.
// Disk is only touched by applyAccepted() via the injected writer (vscode WorkspaceEdit).
import { Proposal, Hunk, applySelectedHunks, markStale, hashContent } from '../diff/proposal';
import type { WorkspaceBridge } from './workspace';
import * as path from 'path';

export interface ApplyResult {
  filePath: string;
  newContent: string;
  acceptedHunks: string[];
  staleHunks: string[];
}

export class PendingStore {
  private proposals = new Map<string, Proposal>(); // proposalId -> proposal
  private byFile = new Map<string, Set<string>>(); // absPath -> proposalIds
  constructor(private bridge: WorkspaceBridge) {}

  add(p: Proposal): void {
    this.proposals.set(p.id, p);
    const abs = path.isAbsolute(p.filePath) ? p.filePath : path.resolve(this.bridge.root, p.filePath);
    if (!this.byFile.has(abs)) this.byFile.set(abs, new Set());
    this.byFile.get(abs)!.add(p.id);
  }

  get(id: string): Proposal | undefined { return this.proposals.get(id); }

  // Content the agent should see: disk + all pending (non-rejected) proposals applied in order.
  overlayContent(absPath: string): string {
    let content = this.bridge.currentContent(absPath);
    const ids = this.byFile.get(absPath);
    if (!ids) return content;
    for (const id of ids) {
      const p = this.proposals.get(id)!;
      if (p.hunks.every(h => h.status === 'rejected')) continue;
      const active = p.hunks.filter(h => h.status !== 'rejected');
      const r = applySelectedHunks(content, active);
      if (r.content !== undefined) content = r.content;
    }
    return content;
  }

  // Accept specific hunks -> returns file(s) needing write. Stale hunks rejected, not applied.
  accept(hunkIds: string[]): { results: ApplyResult[]; errors: string[] } {
    const results: ApplyResult[] = [];
    const errors: string[] = [];
    // group hunks by proposal
    const byProposal = new Map<string, Hunk[]>();
    for (const hid of hunkIds) {
      let found: Hunk | undefined;
      let pid = '';
      for (const [id, p] of this.proposals) {
        found = p.hunks.find(h => h.id === hid);
        if (found) { pid = id; break; }
      }
      if (!found) { errors.push(`hunk ${hid} not found`); continue; }
      if (!byProposal.has(pid)) byProposal.set(pid, []);
      byProposal.get(pid)!.push(found);
    }
    for (const [pid, hunks] of byProposal) {
      const p = this.proposals.get(pid)!;
      const abs = path.isAbsolute(p.filePath) ? p.filePath : path.resolve(this.bridge.root, p.filePath);
      const disk = this.bridge.currentContent(abs);
      if (markStale(p, disk)) {
        errors.push(`${p.filePath}: source changed since proposal; hunks marked stale`);
        continue;
      }
      // apply accepted-set = already-accepted + newly accepted
      const toApply = p.hunks.filter(h => h.status === 'accepted' || hunks.includes(h));
      const r = applySelectedHunks(disk, toApply);
      if (r.staleHunkIds?.length) {
        for (const sid of r.staleHunkIds) {
          const h = p.hunks.find(x => x.id === sid);
          if (h && h.status !== 'accepted') h.status = 'stale';
        }
        errors.push(`${p.filePath}: ${r.staleHunkIds.length} hunk(s) stale, skipped`);
      }
      if (r.content !== undefined) {
        for (const h of hunks) h.status = 'accepted';
        results.push({ filePath: abs, newContent: r.content, acceptedHunks: hunks.map(h => h.id), staleHunks: r.staleHunkIds ?? [] });
      }
    }
    return { results, errors };
  }

  reject(hunkIds: string[]): number {
    let n = 0;
    for (const id of hunkIds) {
      for (const p of this.proposals.values()) {
        const h = p.hunks.find(x => x.id === id);
        if (h && h.status !== 'accepted') { h.status = 'rejected'; n++; }
      }
    }
    return n;
  }

  // Discard all proposals created during a cancelled/failed turn.
  discardTurn(turnId: string): number {
    let n = 0;
    for (const [id, p] of this.proposals) {
      if (p.turnId === turnId) { this.proposals.delete(id); n++; }
    }
    // rebuild byFile
    this.byFile.clear();
    for (const [id, p] of this.proposals) {
      const abs = path.isAbsolute(p.filePath) ? p.filePath : path.resolve(this.bridge.root, p.filePath);
      if (!this.byFile.has(abs)) this.byFile.set(abs, new Set());
      this.byFile.get(abs)!.add(id);
    }
    return n;
  }

  all(): Proposal[] { return [...this.proposals.values()]; }

  pendingHunks(): Array<Hunk & { proposalId: string }> {
    const out: Array<Hunk & { proposalId: string }> = [];
    for (const p of this.proposals.values()) {
      for (const h of p.hunks) if (h.status === 'pending' || h.status === 'stale') out.push({ ...h, proposalId: p.id });
    }
    return out;
  }

  clear(): void { this.proposals.clear(); this.byFile.clear(); }
}
