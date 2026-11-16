import { nextId, type ForgeStore, type Repository, type Issue, type PullRequest } from './store.ts';
import { readObject, storeObject } from './git.ts';
import { parseCommit, parseTree } from './core.ts';

export function timestamp(sequence: number): string { return new Date(1735689600000 + sequence * 1000).toISOString(); }
export function createIssue(s: ForgeStore, repo: Repository, input: any): Issue {
  const labels = (Array.isArray(input.labels) ? input.labels : []).map((name: unknown) => repo.labels.get(String(name)));
  if (labels.some((label: unknown) => !label)) throw Error('Unknown label');
  const number = nextId(repo);
  const issue: Issue = { id: number, number, title: String(input.title || ''), body: String(input.body || ''), state: 'open', user: { login: s.login }, labels, comments: 0, created_seq: number, created_at: timestamp(number), updated_at: timestamp(number) };
  repo.issues.set(number, issue); return issue;
}
export function createPull(s: ForgeStore, repo: Repository, input: any): PullRequest {
  const number = nextId(repo), base = String(input.base || repo.default_branch), head = String(input.head || 'feature');
  const baseSha = resolveRef(s, repo, base) || '', headSha = resolveRef(s, repo, head) || baseSha;
  const pull: PullRequest = { id: number, number, title: String(input.title || ''), body: String(input.body || ''), state: 'open', user: { login: s.login }, labels: [], comments: 0, head: { ref: head, sha: headSha }, base: { ref: base, sha: baseSha }, merged: false, created_seq: number, created_at: timestamp(number), updated_at: timestamp(number) };
  repo.pull_requests.set(number, pull); return pull;
}
export function addComment(s: ForgeStore, repo: Repository, number: number, body: unknown): { id: number; body: string; user: { login: string } } {
  const item = repo.issues.get(number) || repo.pull_requests.get(number);
  if (!item) throw Error('Issue not found');
  const comments = repo.comments.get(number) || [];
  const comment = { id: nextId(repo), body: String(body || ''), user: { login: s.login } };
  comments.push(comment); repo.comments.set(number, comments); item.comments = comments.length;
  return comment;
}
export function resolveRef(s: ForgeStore, repo: Repository, ref: string): string | undefined {
  return s.refs.get(`${repo.full_name}:${ref}`) || s.refs.get(`${repo.full_name}:refs/heads/${ref}`) || (/^[a-f0-9]{40}$/.test(ref) && s.objects.has(ref) ? ref : undefined);
}
export function commitTree(s: ForgeStore, sha: string): string | undefined {
  const object = readObject(s, sha); return object?.type === 'commit' ? parseCommit(object.data).tree : undefined;
}
export function pathEntry(s: ForgeStore, repo: Repository, path: string, ref = repo.default_branch): { oid: string; type: string; data: Buffer } | undefined {
  let oid = commitTree(s, resolveRef(s, repo, ref) || '');
  for (const part of path.split('/').filter(Boolean)) {
    const object = oid ? readObject(s, oid) : undefined;
    if (object?.type !== 'tree') return;
    oid = parseTree(object.data).find(entry => entry.name === part)?.oid;
  }
  const object = oid ? readObject(s, oid) : undefined;
  return object && oid ? { oid, ...object } : undefined;
}
function filesAt(s: ForgeStore, commit: string): Map<string, { oid: string; data: Buffer }> {
  const files = new Map<string, { oid: string; data: Buffer }>();
  const visit = (oid: string, prefix: string) => {
    const object = readObject(s, oid); if (!object) return;
    if (object.type === 'tree') for (const entry of parseTree(object.data)) visit(entry.oid, prefix ? `${prefix}/${entry.name}` : entry.name);
    else if (object.type === 'blob') files.set(prefix, { oid, data: object.data });
  };
  const tree = commitTree(s, commit); if (tree) visit(tree, ''); return files;
}
// LCS yields real line additions/deletions while bounding memory for large binary-like files.
function lineDiff(before: Buffer | undefined, after: Buffer | undefined): { additions: number; deletions: number; patch: string } {
  const lines = (bytes: Buffer | undefined) => { const text = bytes?.toString() || ''; return text ? text.replace(/\n$/, '').split('\n') : []; };
  const a = lines(before), b = lines(after);
  const rows = a.length * b.length <= 1000000 ? Array.from({ length: a.length + 1 }, () => new Uint32Array(b.length + 1)) : null;
  if (rows) for (let i = a.length - 1; i >= 0; i--) for (let j = b.length - 1; j >= 0; j--) rows[i][j] = a[i] === b[j] ? 1 + rows[i + 1][j + 1] : Math.max(rows[i + 1][j], rows[i][j + 1]);
  let i = 0, j = 0, additions = 0, deletions = 0; const patch: string[] = [];
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) { patch.push(` ${a[i++]}`); j++; }
    else if (j < b.length && (i === a.length || !rows || rows[i][j + 1] >= rows[i + 1][j])) { patch.push(`+${b[j++]}`); additions++; }
    else { patch.push(`-${a[i++]}`); deletions++; }
  }
  return { additions, deletions, patch: `@@ -${a.length ? 1 : 0},${a.length} +${b.length ? 1 : 0},${b.length} @@\n${patch.join('\n')}\n` };
}
export function pullFiles(s: ForgeStore, repo: Repository, pull: PullRequest) {
  const before = filesAt(s, pull.base.sha || resolveRef(s, repo, pull.base.ref) || ''), after = filesAt(s, pull.head.sha || resolveRef(s, repo, pull.head.ref) || '');
  return [...new Set([...before.keys(), ...after.keys()])].sort().filter(path => before.get(path)?.oid !== after.get(path)?.oid).map(filename => {
    const old = before.get(filename), next = after.get(filename), diff = lineDiff(old?.data, next?.data);
    return { filename, status: !old ? 'added' : !next ? 'removed' : 'modified', ...diff, changes: diff.additions + diff.deletions };
  });
}
function ancestors(s: ForgeStore, tip: string): Set<string> {
  const seen = new Set<string>(), todo = [tip];
  while (todo.length) { const sha = todo.shift()!; if (seen.has(sha)) continue; seen.add(sha); const object = readObject(s, sha); if (object?.type === 'commit') todo.push(...parseCommit(object.data).parents); }
  return seen;
}
export function mergePull(s: ForgeStore, repo: Repository, pull: PullRequest): { status: number; body: any } {
  if (pull.merged) return { status: 200, body: { merged: true, sha: pull.merge_commit_sha, message: 'Already merged' } };
  const base = resolveRef(s, repo, pull.base.ref) || pull.base.sha || '', head = resolveRef(s, repo, pull.head.ref) || pull.head.sha || '';
  const tree = commitTree(s, head); if (!tree || !commitTree(s, base)) return { status: 405, body: { message: 'Missing commit' } };
  const baseAncestors = ancestors(s, base), headAncestors = ancestors(s, head);
  const common = [...headAncestors].find(sha => baseAncestors.has(sha));
  const original = filesAt(s, common || ''), baseFiles = filesAt(s, base), headFiles = filesAt(s, head);
  for (const path of new Set([...original.keys(), ...baseFiles.keys(), ...headFiles.keys()])) {
    const old = original.get(path)?.oid, b = baseFiles.get(path)?.oid, h = headFiles.get(path)?.oid;
    if (b !== old && h !== old && b !== h) return { status: 405, body: { message: 'Merge conflict' } };
  }
  const data = Buffer.from(`tree ${tree}\nparent ${base}\nparent ${head}\nauthor ${s.login} <forge@local> 0 +0000\ncommitter ${s.login} <forge@local> 0 +0000\n\nMerge pull request #${pull.number}: ${pull.title}\n`);
  const sha = storeObject(s, 'commit', data);
  s.refs.set(`${repo.full_name}:refs/heads/${pull.base.ref}`, sha);
  pull.merged = true; pull.state = 'closed'; pull.merged_at = timestamp(nextId(repo)); pull.merge_commit_sha = sha;
  pull.mergedAt = pull.merged_at; pull.mergeCommitSha = sha;
  if (pull.base.ref === repo.default_branch) { repo.files.clear(); for (const [path, file] of headFiles) repo.files.set(path, file.data.toString()); }
  return { status: 200, body: { merged: true, sha, message: 'Pull Request successfully merged' } };
}
