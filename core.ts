// The forge's in-memory model: SHA-1 git objects, trees, commits, refs, issues, labels, comments and
// pull requests. Everything is derived data held in Maps so the hot paths (issue reads, ref lookups,
// commit walks) never scan a collection linearly.

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';

export type ObjType = 'blob' | 'tree' | 'commit' | 'tag';

export interface GitObject {
  type: ObjType;
  data: Buffer;
}

const TYPE_CODE: Record<ObjType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const CODE_TYPE: Record<number, ObjType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

export function sha1Hex(chunks: readonly Buffer[]): string {
  const hash = createHash('sha1');
  for (const chunk of chunks) hash.update(chunk);
  return hash.digest('hex');
}

export function hashObject(type: ObjType, data: Buffer): string {
  const header = Buffer.from(`${type} ${data.length}\0`, 'utf8');
  return sha1Hex([header, data]);
}

/** A loose object's zlib-compressed bytes (what a real .git/objects/xx/yyyy file holds). */
export function looseBytes(type: ObjType, data: Buffer): Buffer {
  return deflateSync(Buffer.concat([Buffer.from(`${type} ${data.length}\0`, 'utf8'), data]));
}

export interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    if (space < 0) break;
    const mode = data.subarray(offset, space).toString('utf8');
    const nul = data.indexOf(0, space + 1);
    if (nul < 0) break;
    const name = data.subarray(space + 1, nul).toString('utf8');
    const oid = data.subarray(nul + 1, nul + 21).toString('hex');
    entries.push({ mode, name, oid });
    offset = nul + 21;
  }
  return entries;
}

export function buildTree(entries: readonly TreeEntry[]): Buffer {
  const sorted = entries.slice().sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const chunks: Buffer[] = [];
  for (const entry of sorted) {
    chunks.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    chunks.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(chunks);
}

export interface CommitInfo {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
}

export function parseCommit(data: Buffer): CommitInfo {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const head = split < 0 ? text : text.slice(0, split);
  const message = split < 0 ? '' : text.slice(split + 2);
  let tree = '';
  const parents: string[] = [];
  let author = '';
  let committer = '';
  for (const line of head.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5);
    else if (line.startsWith('parent ')) parents.push(line.slice(7));
    else if (line.startsWith('author ')) author = line.slice(7);
    else if (line.startsWith('committer ')) committer = line.slice(10);
  }
  return { tree, parents, author, committer, message };
}

export function buildCommit(input: {
  tree: string;
  parents: readonly string[];
  author: string;
  committer: string;
  message: string;
}): Buffer {
  const lines = [`tree ${input.tree}`];
  for (const parent of input.parents) lines.push(`parent ${parent}`);
  lines.push(`author ${input.author}`, `committer ${input.committer}`, '', input.message);
  return Buffer.from(lines.join('\n'), 'utf8');
}

export interface TagInfo {
  object: string;
  type: string;
  tag: string;
  tagger: string;
  message: string;
}

export function parseTag(data: Buffer): TagInfo {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const head = split < 0 ? text : text.slice(0, split);
  let object = '';
  let type = '';
  let tag = '';
  let tagger = '';
  for (const line of head.split('\n')) {
    if (line.startsWith('object ')) object = line.slice(7);
    else if (line.startsWith('type ')) type = line.slice(5);
    else if (line.startsWith('tag ')) tag = line.slice(4);
    else if (line.startsWith('tagger ')) tagger = line.slice(7);
  }
  return { object, type, tag, tagger, message: split < 0 ? '' : text.slice(split + 2) };
}

export interface PullRef {
  ref: string;
  sha: string;
}

export interface Issue {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  user: string;
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
  comments: number;
}

export interface Comment {
  id: number;
  number: number;
  body: string;
  user: string;
  createdAt: string;
}

export interface PullRequest {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  merged: boolean;
  mergeCommitSha: string | null;
  mergedAt: string | null;
  head: string;
  headSha: string;
  base: string;
  baseSha: string;
  user: string;
  createdAt: string;
  updatedAt: string;
  draft: boolean;
}

export interface PullFile {
  filename: string;
  status: string;
  additions: number;
  deletions: number;
  changes: number;
  patch: string;
  previousFilename?: string;
}

export interface Repo {
  id: number;
  owner: string;
  name: string;
  description: string;
  private: boolean;
  defaultBranch: string;
  createdAt: string;
  updatedAt: string;
  objects: Map<string, GitObject>;
  refs: Map<string, string>;
  /** Reachable-from map is computed on demand; these caches keep clones fast. */
  issues: Issue[];
  issueByNumber: Map<number, Issue>;
  comments: Map<number, Comment[]>;
  pulls: PullRequest[];
  pullByNumber: Map<number, PullRequest>;
  labels: Map<string, { name: string; color: string; description: string }>;
  counters: { issue: number; pull: number; comment: number; id: number };
  /** Objects known reachable from each ref tip, invalidated when refs move. */
  closureCache: Map<string, Set<string>>;
}

export interface Store {
  repos: Map<string, Repo>;
  byOwner: Map<string, Repo[]>;
  nextRepoId: number;
  nextGlobalId: number;
  viewer: { login: string; id: number; name: string; email: string };
}

export function emptyRepo(store: Store, owner: string, name: string, description: string, priv: boolean, createdAt: string): Repo {
  const id = store.nextRepoId++;
  const repo: Repo = {
    id,
    owner,
    name,
    description,
    private: priv,
    defaultBranch: 'main',
    createdAt,
    updatedAt: createdAt,
    objects: new Map(),
    refs: new Map(),
    issues: [],
    issueByNumber: new Map(),
    comments: new Map(),
    pulls: [],
    pullByNumber: new Map(),
    labels: new Map(),
    counters: { issue: 0, pull: 0, comment: 0, id: 1 },
    closureCache: new Map(),
  };
  store.repos.set(`${owner}/${name}`.toLowerCase(), repo);
  const list = store.byOwner.get(owner.toLowerCase());
  if (list === undefined) store.byOwner.set(owner.toLowerCase(), [repo]);
  else list.push(repo);
  return repo;
}

export function findRepo(store: Store, owner: string, name: string): Repo | null {
  const repo = store.repos.get(`${owner}/${name}`.toLowerCase());
  if (repo === undefined) return null;
  // The owner comparison is case-insensitive but must not let another owner's name through.
  if (repo.owner.toLowerCase() !== owner.toLowerCase()) return null;
  return repo;
}

export function getObject(repo: Repo, oid: string): GitObject | null {
  return repo.objects.get(oid) ?? null;
}

export function putObject(repo: Repo, type: ObjType, data: Buffer): string {
  const oid = hashObject(type, data);
  if (!repo.objects.has(oid)) repo.objects.set(oid, { type, data });
  return oid;
}

export function refTip(repo: Repo, ref: string): string | null {
  return repo.refs.get(ref) ?? null;
}

export function branchTip(repo: Repo, branch: string): string | null {
  return refTip(repo, `refs/heads/${branch}`);
}

/** The commit a ref or branch name points at, peeling annotated tags. */
export function resolveCommit(repo: Repo, nameOrSha: string): string | null {
  const direct = repo.refs.get(nameOrSha) ?? repo.refs.get(`refs/heads/${nameOrSha}`) ?? repo.refs.get(`refs/tags/${nameOrSha}`);
  if (direct !== undefined) return peelToCommit(repo, direct);
  if (/^[0-9a-f]{40}$/.test(nameOrSha) && repo.objects.has(nameOrSha)) return peelToCommit(repo, nameOrSha);
  return null;
}

export function peelToCommit(repo: Repo, oid: string): string | null {
  let current = oid;
  for (let guard = 0; guard < 8; guard += 1) {
    const object = repo.objects.get(current);
    if (object === undefined) return null;
    if (object.type === 'commit') return current;
    if (object.type === 'tag') {
      current = parseTag(object.data).object;
      continue;
    }
    return null;
  }
  return null;
}

/** Every object reachable from a commit (commit, trees, blobs), memoised per tip. */
export function reachableFrom(repo: Repo, tip: string): Set<string> {
  const cached = repo.closureCache.get(tip);
  if (cached !== undefined) return cached;
  const seen = new Set<string>();
  const stack: string[] = [tip];
  while (stack.length > 0) {
    const oid = stack.pop() as string;
    if (seen.has(oid)) continue;
    const object = repo.objects.get(oid);
    if (object === undefined) continue;
    seen.add(oid);
    if (object.type === 'commit') {
      const commit = parseCommit(object.data);
      stack.push(commit.tree);
      for (const parent of commit.parents) stack.push(parent);
    } else if (object.type === 'tree') {
      for (const entry of parseTree(object.data)) stack.push(entry.oid);
    } else if (object.type === 'tag') {
      stack.push(parseTag(object.data).object);
    }
  }
  if (repo.closureCache.size > 512) repo.closureCache.clear();
  repo.closureCache.set(tip, seen);
  return seen;
}

export function invalidateRef(repo: Repo, ref: string): void {
  // Cheap and correct: a ref move invalidates every memoised closure that could contain it.
  repo.closureCache.clear();
  void ref;
}

/** Whether `descendant` has `ancestor` in its parent chain. */
export function isAncestor(repo: Repo, ancestor: string, descendant: string): boolean {
  if (ancestor === descendant) return true;
  const seen = new Set<string>();
  const stack: string[] = [descendant];
  while (stack.length > 0) {
    const oid = stack.pop() as string;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const object = repo.objects.get(oid);
    if (object === undefined || object.type !== 'commit') continue;
    for (const parent of parseCommit(object.data).parents) {
      if (parent === ancestor) return true;
      stack.push(parent);
    }
  }
  return false;
}

/** A path's blob oid and its content, resolved through a commit's tree. */
export function readPath(repo: Repo, commitSha: string, path: string): { oid: string; data: Buffer; mode: string } | null {
  const commitObject = repo.objects.get(commitSha);
  if (commitObject === undefined || commitObject.type !== 'commit') return null;
  const segments = path.split('/').filter((segment) => segment !== '');
  let oid = parseCommit(commitObject.data).tree;
  let mode = '40000';
  for (let index = 0; index < segments.length; index += 1) {
    const treeObject = repo.objects.get(oid);
    if (treeObject === undefined || treeObject.type !== 'tree') return null;
    const entry = parseTree(treeObject.data).find((candidate) => candidate.name === segments[index]);
    if (entry === undefined) return null;
    oid = entry.oid;
    mode = entry.mode;
  }
  const object = repo.objects.get(oid);
  if (object === undefined) return null;
  return { oid, data: object.data, mode };
}

/** The entries of a directory in a commit's tree (empty when the path is not a directory). */
export function listDir(repo: Repo, commitSha: string, path: string): TreeEntry[] | null {
  const commitObject = repo.objects.get(commitSha);
  if (commitObject === undefined || commitObject.type !== 'commit') return null;
  let oid = parseCommit(commitObject.data).tree;
  const segments = path.split('/').filter((segment) => segment !== '');
  for (const segment of segments) {
    const treeObject = repo.objects.get(oid);
    if (treeObject === undefined || treeObject.type !== 'tree') return null;
    const entry = parseTree(treeObject.data).find((candidate) => candidate.name === segment);
    if (entry === undefined) return null;
    oid = entry.oid;
  }
  const treeObject = repo.objects.get(oid);
  if (treeObject === undefined || treeObject.type !== 'tree') return null;
  return parseTree(treeObject.data);
}

/** Write a new tree replacing one path (creating parent trees as needed); returns the root tree oid. */
export function writePath(repo: Repo, rootTree: string | null, path: string, blobOid: string | null, mode = '100644'): string {
  const segments = path.split('/').filter((segment) => segment !== '');
  const write = (treeOid: string | null, depth: number): string => {
    const entries = treeOid === null ? [] : parseTree((repo.objects.get(treeOid) as GitObject).data);
    const name = segments[depth];
    const rest = entries.filter((entry) => entry.name !== name);
    if (depth === segments.length - 1) {
      if (blobOid !== null) rest.push({ mode, name, oid: blobOid });
    } else {
      const existing = entries.find((entry) => entry.name === name);
      const childOid = write(existing === undefined ? null : existing.oid, depth + 1);
      rest.push({ mode: '40000', name, oid: childOid });
    }
    return putObject(repo, 'tree', buildTree(rest));
  };
  return write(rootTree, 0);
}
