import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { retrieve, formatContextBlock, extractMentions, extractSymbols } from '../src/context/retrieval';
import { safeResolve, runShell } from '../src/editor/workspace';

describe('retrieval', () => {
  it('extracts @mentions and @symbols', () => {
    expect(extractMentions('edit @src/flask/helpers.py now')).toContain('src/flask/helpers.py');
    expect(extractSymbols('fix @get_debug_flag please')).toContain('get_debug_flag');
  });

  it('ranks symbol matches and respects budget', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hg-ctx-'));
    fs.mkdirSync(path.join(root, 'src'), { recursive: true });
    fs.writeFileSync(path.join(root, 'src', 'helpers.py'), 'def get_debug_flag():\n    return True\n' + 'x = 1\n'.repeat(500));
    fs.writeFileSync(path.join(root, 'other.py'), 'nothing relevant\n'.repeat(100));
    const r = retrieve(root, 'update @get_debug_flag docstring', { budgetTokens: 500, lowEnd: true });
    expect(r.chunks.length).toBeGreaterThan(0);
    expect(r.chunks[0].path).toContain('helpers.py');
    expect(r.estimatedTokens).toBeLessThanOrEqual(500);
    const block = formatContextBlock(r, true);
    expect(block).toContain('low-end mode');
  });

  it('low-end mode caps files and lines harder', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hg-le-'));
    for (let i = 0; i < 30; i++) fs.writeFileSync(path.join(root, `f${i}.py`), `needle${i}\n` + 'y\n'.repeat(300));
    const r = retrieve(root, 'needle', { budgetTokens: 12000, lowEnd: true });
    expect(r.chunks.length).toBeLessThanOrEqual(8);
  });
});

describe('workspace safety', () => {
  it('safeResolve blocks path escape', () => {
    const root = 'D:\\proj';
    expect(safeResolve(root, '../evil.txt')).toBeNull();
    expect(safeResolve(root, 'src/a.py')).toContain('src');
  });

  it('runShell captures output and timeout', async () => {
    const r = await runShell('echo hello-hg', process.cwd(), 10000);
    expect(r.stdout).toContain('hello-hg');
    expect(r.code).toBe(0);
    const t = await runShell(process.platform === 'win32' ? 'ping -n 10 127.0.0.1' : 'sleep 5', process.cwd(), 800);
    expect(t.timedOut).toBe(true);
  }, 20000);
});
