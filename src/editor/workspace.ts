// Workspace operations behind the MCP tools. Pure fs/path logic lives here so it
// is unit-testable; the vscode layer injects workspace root + overlay reads.
import * as fs from 'fs';
import * as path from 'path';
import { execFile } from 'child_process';

export interface WorkspaceBridge {
  root: string;
  // Read with pending-proposal overlay applied. bounded by maxLines.
  readFile(relOrAbs: string, maxLines: number): { content: string; truncated: boolean; path: string };
  // Search file names + content. Returns bounded matches.
  search(query: string, maxResults: number): Array<{ path: string; line?: number; preview: string }>;
  // Register a proposal (does NOT touch disk).
  propose(filePath: string, ops: Array<{ old_string: string; new_string: string }>, turnId: string): { proposalId?: string; error?: string };
  runCommand(command: string, timeoutMs: number): Promise<{ stdout: string; stderr: string; code: number | null; timedOut: boolean }>;
  currentContent(filePath: string): string; // disk content (no overlay)
}

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'out', '.hunkguard', '__pycache__', '.venv', 'venv']);
const TEXT_EXT = new Set(['.py', '.ts', '.tsx', '.js', '.jsx', '.json', '.md', '.rst', '.txt', '.yaml', '.yml', '.toml', '.cfg', '.ini', '.html', '.css', '.sh', '.ps1']);

export function safeResolve(root: string, p: string): string | null {
  const abs = path.isAbsolute(p) ? path.resolve(p) : path.resolve(root, p);
  const rel = path.relative(root, abs);
  if (rel.startsWith('..') || path.isAbsolute(rel)) return null;
  return abs;
}

export function isTextFile(p: string): boolean {
  return TEXT_EXT.has(path.extname(p).toLowerCase()) || !path.extname(p);
}

export function walkFiles(root: string, maxFiles = 5000): string[] {
  const out: string[] = [];
  const stack = [root];
  while (stack.length && out.length < maxFiles) {
    const dir = stack.pop()!;
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name) && !e.name.startsWith('.')) stack.push(full);
      } else if (e.isFile() && isTextFile(e.name)) {
        out.push(full);
        if (out.length >= maxFiles) break;
      }
    }
  }
  return out;
}

let cachedShell: { cmd: string; args: (c: string) => string[] } | null = null;

function pickShell(): { cmd: string; args: (c: string) => string[] } {
  if (cachedShell) return cachedShell;
  if (process.platform === 'win32') {
    // Prefer Git Bash: POSIX quoting/pipes/heredocs behave sanely for agents.
    for (const p of [process.env.GIT_BASH, 'C:\\Program Files\\Git\\bin\\bash.exe', 'C:\\Program Files (x86)\\Git\\bin\\bash.exe']) {
      if (p && fs.existsSync(p)) {
        cachedShell = { cmd: p, args: (c) => ['-c', c] };
        return cachedShell;
      }
    }
    cachedShell = { cmd: 'cmd.exe', args: (c) => ['/d', '/s', '/c', c] };
    return cachedShell;
  }
  cachedShell = { cmd: '/bin/sh', args: (c) => ['-c', c] };
  return cachedShell;
}
export function runShell(command: string, cwd: string, timeoutMs: number): Promise<{ stdout: string; stderr: string; code: number | null; timedOut: boolean }> {
  return new Promise((resolve) => {
    const { cmd, args } = pickShell();
    execFile(cmd, args(command), { cwd, timeout: timeoutMs, maxBuffer: 1024 * 1024, windowsHide: true }, (err, stdout, stderr) => {
      const timedOut = !!err && (err as NodeJS.ErrnoException & { killed?: boolean }).killed === true;
      const code = err && typeof (err as { code?: unknown }).code === 'number' ? (err as { code: number }).code : err ? 1 : 0;
      resolve({
        stdout: String(stdout).slice(0, 60000),
        stderr: String(stderr).slice(0, 20000),
        code: timedOut ? null : code,
        timedOut,
      });
    });
  });
}
