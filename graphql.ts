import { getRepo, type ForgeStore, type Repository, type Issue, type PullRequest } from './store.ts';
import { createIssue, createPull, addComment, mergePull, pullFiles } from './resources.ts';

type Field = { name: string; alias: string; args: Record<string, any>; fields: Field[]; fragment?: string };
// A selection-set parser with recursive input values, variables, aliases and inline fragments.
function parse(source: string, variables: Record<string, any>): Field[] {
  const tokens = source.match(/\.\.\.|\$[A-Za-z_]\w*|[A-Za-z_]\w*|-?\d+(?:\.\d+)?|"(?:\\.|[^"\\])*"|[^\s,#]/g) || [];
  let index = 0;
  const take = () => { if (index >= tokens.length) throw Error('Unexpected end of document'); return tokens[index++]; };
  const expect = (value: string) => { if (take() !== value) throw Error(`Expected ${value}`); };
  const value = (): any => {
    const token = take();
    if (token.startsWith('$')) { if (!(token.slice(1) in variables)) return null; return variables[token.slice(1)]; }
    if (token.startsWith('"')) return JSON.parse(token);
    if (token === '[') { const values = []; while (tokens[index] !== ']') values.push(value()); expect(']'); return values; }
    if (token === '{') { const object: Record<string, any> = {}; while (tokens[index] !== '}') { const key = take(); expect(':'); object[key] = value(); } expect('}'); return object; }
    if (token === 'null') return null;
    if (token === 'true' || token === 'false') return token === 'true';
    return /^-?\d/.test(token) ? Number(token) : token;
  };
  const selection = (): Field[] => {
    expect('{'); const fields: Field[] = [];
    while (tokens[index] !== '}') {
      let name = take();
      if (name === '...') { expect('on'); const fragment = take(); fields.push({ name: '', alias: '', args: {}, fields: selection(), fragment }); continue; }
      let alias = name;
      if (tokens[index] === ':') { take(); name = take(); }
      const args: Record<string, any> = {};
      if (tokens[index] === '(') { take(); while (tokens[index] !== ')') { const key = take(); expect(':'); args[key] = value(); } expect(')'); }
      fields.push({ name, alias, args, fields: tokens[index] === '{' ? selection() : [] });
    }
    expect('}'); return fields;
  };
  // Skip the operation name and variable definitions, which may themselves contain input objects.
  if (tokens[0] === 'query' || tokens[0] === 'mutation') {
    take(); if (tokens[index] !== '(' && tokens[index] !== '{') take();
    if (tokens[index] === '(') { let depth = 0; do { const token = take(); if (token === '(') depth++; if (token === ')') depth--; } while (depth); }
  }
  const fields = selection();
  if (index !== tokens.length) throw Error('Multiple operations are not supported in one document');
  return fields;
}

const schema: Record<string, string[]> = {
  Query: ['viewer', 'repository', 'node', '__type'],
  Mutation: ['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment'],
  User: ['login'], Repository: ['id', 'databaseId', 'name', 'nameWithOwner', 'description', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest'],
  Issue: ['id', 'number', 'title', 'state', 'body'], PullRequest: ['id', 'number', 'title', 'body', 'headRefName', 'baseRefName', 'mergeable', 'state', 'merged', 'files'],
  Ref: ['name'], Connection: ['nodes', 'pageInfo'], PageInfo: ['hasNextPage', 'endCursor'], File: ['path'],
  Type: ['fields', 'enumValues'], Named: ['name'], IssuePayload: ['issue'], PullPayload: ['pullRequest'], CommentPayload: ['commentEdge'], CommentEdge: ['node'], Comment: ['id', 'body'],
};
const idFor = (type: string, repo: Repository, number?: number) => Buffer.from(JSON.stringify([type, repo.full_name, number ?? null])).toString('base64url');
type Node = { type: string; value: any; repo?: Repository };
const node = (type: string, value: any, repo?: Repository): Node => ({ type, value, repo });

function execute(s: ForgeStore, doc: any): unknown {
  const errors: { message: string }[] = [];
  try {
    if (!doc || typeof doc.query !== 'string') throw Error('A query string is required');
    const fields = parse(doc.query, doc.variables || {});
    const lookup = (id: string): Node | null => {
      let parts: any; try { parts = JSON.parse(Buffer.from(String(id), 'base64url').toString()); } catch { throw Error('Invalid global id'); }
      const [type, key, number] = parts, repo = s.repos.get(key);
      if (!repo) return null;
      if (type === 'Repository') return node(type, repo, repo);
      const item = type === 'Issue' ? repo.issues.get(number) : type === 'PullRequest' ? repo.pull_requests.get(number) : undefined;
      return item ? node(type, item, repo) : null;
    };
    const connection = (items: Node[], args: any): Node => {
      const first = args.first == null ? 30 : Number(args.first);
      if (!Number.isInteger(first) || first < 0) throw Error('first must be a nonnegative integer');
      let start = 0;
      if (args.after) { const cursor = Buffer.from(String(args.after), 'base64url').toString(); const found = items.findIndex(item => String(item.value.number) === cursor.replace(/^cursor:/, '')); if (found < 0) throw Error('Invalid cursor'); start = found + 1; }
      const selected = items.slice(start, start + first);
      return node('Connection', { nodes: selected, pageInfo: node('PageInfo', { hasNextPage: start + selected.length < items.length, endCursor: selected.length ? Buffer.from(`cursor:${selected.at(-1)!.value.number}`).toString('base64url') : null }) });
    };
    const resolve = (parent: Node, field: Field): any => {
      const { type, value, repo } = parent, a = field.args, name = field.name;
      if (type === 'Query') {
        if (name === 'viewer') return node('User', { login: s.login });
        if (name === 'repository') { if (typeof a.owner !== 'string' || typeof a.name !== 'string') throw Error('repository requires owner and name'); const r = getRepo(s, a.owner, a.name); return r && a.owner === s.login ? node('Repository', r, r) : null; }
        if (name === 'node') return lookup(a.id);
        if (name === '__type') return schema[a.name] || a.name === 'SearchType' ? node('Type', { fields: (schema[a.name] || []).map(name => node('Named', { name })), enumValues: a.name === 'SearchType' ? ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION'].map(name => node('Named', { name })) : [] }) : null;
      }
      if (type === 'Mutation') {
        const input = a.input; if (!input || typeof input !== 'object') throw Error(`${name} requires input`);
        const target = lookup(input.repositoryId || input.issueId || input.pullRequestId || input.subjectId);
        if (!target?.repo) throw Error('Unknown mutation target');
        const r = target.repo;
        if (name === 'createIssue') { if (!input.title || target.type !== 'Repository') throw Error('createIssue requires a repository and title'); return node('IssuePayload', { issue: node('Issue', createIssue(s, r, input), r) }); }
        if (name === 'closeIssue') { if (target.type !== 'Issue') throw Error('Expected issue id'); target.value.state = 'closed'; return node('IssuePayload', { issue: target }); }
        if (name === 'createPullRequest') return node('PullPayload', { pullRequest: node('PullRequest', createPull(s, r, { ...input, head: input.headRefName, base: input.baseRefName }), r) });
        if (name === 'mergePullRequest') { if (target.type !== 'PullRequest') throw Error('Expected pull request id'); const result = mergePull(s, r, target.value); if (result.status !== 200) throw Error(result.body.message); return node('PullPayload', { pullRequest: target }); }
        if (name === 'addComment') { if (!['Issue', 'PullRequest'].includes(target.type)) throw Error('Expected issue or pull request id'); const comment = addComment(s, r, target.value.number, input.body); return node('CommentPayload', { commentEdge: node('CommentEdge', { node: node('Comment', { ...comment, id: idFor('Comment', r, comment.id) }) }) }); }
      }
      if (type === 'Repository') {
        const r = value as Repository;
        if (name === 'id') return idFor('Repository', r);
        if (name === 'databaseId') return r.id;
        if (name === 'nameWithOwner') return r.full_name;
        if (name === 'owner') return node('User', r.owner);
        if (name === 'defaultBranchRef') return node('Ref', { name: r.default_branch });
        if (name === 'viewerPermission') return 'ADMIN';
        if (name === 'hasIssuesEnabled') return true;
        if (name === 'issue' || name === 'pullRequest') { if (!Number.isInteger(a.number) || a.number < 1) throw Error('number must be a positive integer'); const item = name === 'issue' ? r.issues.get(a.number) : r.pull_requests.get(a.number); return item ? node(name === 'issue' ? 'Issue' : 'PullRequest', item, r) : null; }
        if (name === 'issues' || name === 'pullRequests') {
          const isIssue = name === 'issues';
          let items = [...(isIssue ? r.issues : r.pull_requests).values()].filter(item => !a.states || a.states.includes(item.state.toUpperCase()));
          if (a.orderBy?.direction === 'DESC') items.sort((x, y) => y.number - x.number); else items.sort((x, y) => x.number - y.number);
          return connection(items.map(item => node(isIssue ? 'Issue' : 'PullRequest', item, r)), a);
        }
      }
      if (type === 'Issue' || type === 'PullRequest') {
        if (name === 'id') return idFor(type, repo!, value.number);
        if (name === 'state') return value.state.toUpperCase();
        if (name === 'headRefName') return value.head.ref;
        if (name === 'baseRefName') return value.base.ref;
        if (name === 'mergeable') return 'MERGEABLE';
        if (name === 'files') return node('Connection', { nodes: pullFiles(s, repo!, value as PullRequest).slice(0, a.first ?? 30).map(file => node('File', { path: file.filename })) });
      }
      return value[name] ?? null;
    };
    const project = (parent: Node, selection: Field[]): Record<string, any> => {
      const out: Record<string, any> = {};
      for (const field of selection) {
        if (field.fragment) { if (parent.type === field.fragment) Object.assign(out, project(parent, field.fields)); continue; }
        if (!schema[parent.type]?.includes(field.name)) { errors.push({ message: `Unknown field ${field.name} on ${parent.type}` }); out[field.alias] = null; continue; }
        try {
          const result = resolve(parent, field);
          const selected = (value: any): any => value == null ? null : Array.isArray(value) ? value.map(selected) : field.fields.length ? project(value, field.fields) : value;
          out[field.alias] = selected(result);
        } catch (error) { out[field.alias] = null; errors.push({ message: error instanceof Error ? error.message : 'Execution failed' }); }
      }
      return out;
    };
    const data = project(node(/^\s*mutation\b/.test(doc.query) ? 'Mutation' : 'Query', {}), fields);
    return errors.length ? { data, errors } : { data };
  } catch (error) { return { data: null, errors: [{ message: error instanceof Error ? error.message : 'Invalid operation' }] }; }
}

export function graphql(s: ForgeStore, payload: string): unknown {
  let doc: any; try { doc = JSON.parse(payload); } catch { return { data: null, errors: [{ message: 'Invalid operation JSON' }] }; }
  return Array.isArray(doc) ? doc.map(operation => execute(s, operation)) : execute(s, doc);
}
