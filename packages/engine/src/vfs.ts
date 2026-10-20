import type { DirSpec, FileSpec } from './types.js';

/** A live virtual file system for one node. Files are flat inside directories;
 *  paths are POSIX-style, rooted at `/`. */
export class Vfs {
  private root: DirSpec;

  constructor(root: DirSpec) {
    this.root = root;
  }

  /** Standard node layout: readme at /, loot dirs at top level, logs in /var/log. */
  static specRoot(hostname: string, dirs: DirSpec[]): DirSpec {
    return {
      name: '/',
      files: [
        {
          name: 'readme.txt',
          tag: 'plain',
          content:
            `${hostname} — internal node. Unauthorized access is monitored.\n` +
            `Segments of this node are the property of the grid trust. You agree to this\n` +
            `by reading this file.`,
        },
      ],
      dirs: [
        ...dirs,
        {
          name: 'home',
          files: [],
          dirs: [{ name: 'operator', files: [], dirs: [] }],
        },
        {
          name: 'var',
          files: [],
          dirs: [{ name: 'log', files: [] }],
        },
      ],
    };
  }

  get rootDir(): DirSpec {
    return this.root;
  }

  /** Split `/var/log/auth.log` → ['var','log','auth.log']; '' → []. */
  static splitPath(p: string): string[] {
    return p.split('/').filter((s) => s.length > 0);
  }

  /** Resolve a path against cwd (a path into the tree). Returns the parent dir + basename. */
  private resolveParts(path: string, cwd: string[]): { parts: string[] } | null {
    const raw = Vfs.splitPath(path);
    const parts = path.startsWith('/') ? [] : [...cwd];
    for (const seg of raw) {
      if (seg === '.') continue;
      if (seg === '..') {
        parts.pop();
        continue;
      }
      parts.push(seg);
    }
    return { parts };
  }

  private walk(parts: string[]): DirSpec | null {
    let dir: DirSpec = this.root;
    for (const seg of parts) {
      const next = dir.dirs?.find((d) => d.name === seg);
      if (!next) return null;
      dir = next;
    }
    return dir;
  }

  resolveDir(path: string, cwd: string[]): DirSpec | null {
    const parts = this.resolveParts(path, cwd);
    if (!parts) return null;
    return this.walk(parts.parts);
  }

  resolveFile(path: string, cwd: string[]): { file: FileSpec; dir: DirSpec } | null {
    const parts = this.resolveParts(path, cwd);
    if (!parts || parts.parts.length === 0) return null;
    const name = parts.parts[parts.parts.length - 1]!;
    const dir = this.walk(parts.parts.slice(0, -1));
    if (!dir) return null;
    const file = dir.files.find((f) => f.name === name);
    return file ? { file, dir } : null;
  }

  /** Entries of a directory for `ls`. */
  list(path: string, cwd: string[]): { dirs: string[]; files: FileSpec[] } | null {
    const dir = this.resolveDir(path || '.', cwd);
    if (!dir) return null;
    return { dirs: (dir.dirs ?? []).map((d) => d.name), files: dir.files };
  }

  removeFile(path: string, cwd: string[]): FileSpec | null {
    const hit = this.resolveFile(path, cwd);
    if (!hit) return null;
    hit.dir.files = hit.dir.files.filter((f) => f !== hit.file);
    return hit.file;
  }

  /** All log files anywhere on this node (for HUD "logs left"). */
  allLogs(): { file: FileSpec; path: string }[] {
    const out: { file: FileSpec; path: string }[] = [];
    const visit = (dir: DirSpec, prefix: string) => {
      for (const f of dir.files) {
        if (f.tag === 'log') out.push({ file: f, path: prefix + f.name });
      }
      for (const d of dir.dirs ?? []) visit(d, `${prefix}${d.name}/`);
    };
    visit(this.root, '/');
    return out;
  }

  allLoot(): { file: FileSpec; path: string }[] {
    const out: { file: FileSpec; path: string }[] = [];
    const visit = (dir: DirSpec, prefix: string) => {
      for (const f of dir.files) {
        if (f.tag === 'loot' || f.tag === 'target') out.push({ file: f, path: prefix + f.name });
      }
      for (const d of dir.dirs ?? []) visit(d, `${prefix}${d.name}/`);
    };
    visit(this.root, '/');
    return out;
  }

  /** All plain readable files (lore). */
  allPlain(): { file: FileSpec; path: string }[] {
    const out: { file: FileSpec; path: string }[] = [];
    const visit = (dir: DirSpec, prefix: string) => {
      for (const f of dir.files) {
        if (f.tag === 'plain') out.push({ file: f, path: prefix + f.name });
      }
      for (const d of dir.dirs ?? []) visit(d, `${prefix}${d.name}/`);
    };
    visit(this.root, '/');
    return out;
  }
}

/** Depth-first walk of every file in a spec tree (no Vfs instance needed). */
export function walkSpecFiles(root: DirSpec): FileSpec[] {
  const out: FileSpec[] = [];
  const visit = (d: DirSpec) => {
    out.push(...d.files);
    for (const sub of d.dirs ?? []) visit(sub);
  };
  visit(root);
  return out;
}

/** Same walk, but carrying each file's absolute path (e.g. `/srv/ledger.dat`). */
export function walkSpecFilesWithPaths(root: DirSpec): { file: FileSpec; path: string }[] {
  const out: { file: FileSpec; path: string }[] = [];
  const visit = (d: DirSpec, prefix: string) => {
    for (const f of d.files) out.push({ file: f, path: prefix + f.name });
    for (const sub of d.dirs ?? []) visit(sub, `${prefix}${sub.name}/`);
  };
  visit(root, '/');
  return out;
}

/** Tag → ls annotation. */
export function describeFile(f: FileSpec): string {
  switch (f.tag) {
    case 'target':
      return `LOOT $${f.value ?? 0} · TARGET`;
    case 'loot':
      return `LOOT $${f.value ?? 0}`;
    case 'log':
      return 'LOG · rm to clear trace';
    case 'payload':
      return 'PLANTED';
    default:
      return '';
  }
}
