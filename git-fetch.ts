import type { ForgeStore } from './store.ts';
import { readObject, pkt, flush, makePack } from './git.ts';

export function requestLines(body: Buffer): string[] {
  const lines: string[] = [];
  for (let offset = 0; offset + 4 <= body.length;) {
    const length = Number.parseInt(body.toString('ascii', offset, offset + 4), 16);
    if (!Number.isFinite(length)) break;
    if (length <= 2) { offset += 4; continue; }
    if (length < 4 || offset + length > body.length) break;
    lines.push(body.toString('utf8', offset + 4, offset + length).replace(/\n$/, ''));
    offset += length;
  }
  return lines;
}

export function listRefs(s: ForgeStore, key: string, refs: readonly (readonly [string, string])[], lines: string[]): Buffer {
  const prefixes = lines.filter(line => line.startsWith('ref-prefix ')).map(line => line.slice(11));
  const keep = (name: string) => !prefixes.length || prefixes.some(prefix => name.startsWith(prefix));
  const branch = `refs/heads/${s.repos.get(key)!.default_branch}`;
  const head = refs.find(([ref]) => ref === branch);
  const out: Buffer[] = [];
  if (keep('HEAD')) {
    const symref = lines.includes('symrefs') ? ` symref-target:${branch}` : '';
    if (head) out.push(pkt(`${head[1]} HEAD${symref}\n`));
    else if (lines.includes('unborn')) out.push(pkt(`unborn HEAD${symref}\n`));
  }
  for (const [ref, sha] of refs) {
    if (!keep(ref)) continue;
    let peeled = sha;
    const seen = new Set<string>();
    while (!seen.has(peeled)) {
      seen.add(peeled);
      const object = readObject(s, peeled);
      if (object?.type !== 'tag') break;
      const target = object.data.toString().match(/^object ([0-9a-f]{40})/m)?.[1];
      if (!target) break;
      peeled = target;
    }
    out.push(pkt(`${sha} ${ref}${lines.includes('peel') && peeled !== sha ? ` peeled:${peeled}` : ''}\n`));
  }
  return Buffer.concat([...out, flush()]);
}

// Walk commit generations separately from trees so a shallow boundary still delivers all files.
function closure(s: ForgeStore, roots: string[], depth: number, stops: Set<string>, since = 0): { objects: Map<string, Buffer>; boundary: Set<string> } {
  const objects = new Map<string, Buffer>(), boundary = new Set<string>();
  const visited = new Map<string, number>();
  const todo: [string, number][] = roots.map(sha => [sha, 1]);
  while (todo.length) {
    const [sha, generation] = todo.shift()!;
    if ((visited.get(sha) ?? Infinity) <= generation) continue;
    visited.set(sha, generation);
    const raw = s.objects.get(sha), object = readObject(s, sha);
    if (!raw || !object) continue;
    objects.set(sha, raw);
    if (object.type === 'commit') {
      const text = object.data.toString();
      const tree = text.match(/^tree ([0-9a-f]{40})/m)?.[1];
      if (tree) todo.push([tree, generation]);
      const parents = [...text.matchAll(/^parent ([0-9a-f]{40})/gm)].map(match => match[1]);
      const old = since > 0 && parents.some(parent => {
        const data = readObject(s, parent)?.data.toString() || '';
        return Number(data.match(/^committer .* (\d+) [+-]\d{4}$/m)?.[1] || 0) < since;
      });
      if (parents.length && (generation >= depth || stops.has(sha) || old)) boundary.add(sha);
      else { boundary.delete(sha); for (const parent of parents) todo.push([parent, generation + 1]); }
    } else if (object.type === 'tree') {
      for (let offset = 0; offset < object.data.length;) {
        const nul = object.data.indexOf(0, offset);
        if (nul < 0 || nul + 21 > object.data.length) break;
        todo.push([object.data.subarray(nul + 1, nul + 21).toString('hex'), generation]);
        offset = nul + 21;
      }
    } else if (object.type === 'tag') {
      const target = object.data.toString().match(/^object ([0-9a-f]{40})/m)?.[1];
      if (target) todo.push([target, generation]);
    }
  }
  return { objects, boundary };
}

export function fetchResponse(s: ForgeStore, lines: string[]): Buffer {
  const v2 = lines.includes('command=fetch');
  const values = (prefix: string) => lines.filter(line => line.startsWith(prefix)).map(line => line.slice(prefix.length).split(' ')[0]);
  const wants = values('want '), haves = values('have '), shallow = values('shallow ');
  const requestedDepth = Number(values('deepen ')[0]) || Infinity;
  const relative = lines.some(line => line.split(' ').includes('deepen-relative'));
  // Absolute deepen N counts from wants. Real Git's --deepen uses deepen-relative.
  const stops = new Set(requestedDepth === Infinity ? shallow : []);
  let selected = closure(s, wants, relative ? Infinity : requestedDepth, relative ? new Set(shallow) : stops, Number(values('deepen-since ')[0]) || 0);
  if (relative && Number.isFinite(requestedDepth)) {
    for (const boundary of shallow) {
      const extra = closure(s, [boundary], requestedDepth + 1, new Set());
      for (const [sha, raw] of extra.objects) selected.objects.set(sha, raw);
      selected.boundary.delete(boundary);
      for (const sha of extra.boundary) selected.boundary.add(sha);
    }
  }
  const unshallow = shallow.filter(sha => selected.objects.has(sha) && !selected.boundary.has(sha));
  const held = closure(s, haves, Infinity, new Set(shallow)).objects;
  for (const sha of held.keys()) selected.objects.delete(sha);
  const shallowLines = [
    ...[...selected.boundary].filter(sha => !shallow.includes(sha)).map(sha => pkt(`shallow ${sha}\n`)),
    ...unshallow.map(sha => pkt(`unshallow ${sha}\n`)),
  ];
  const pack = makePack(selected.objects), bands: Buffer[] = [];
  for (let offset = 0; offset < pack.length; offset += 65000) bands.push(pkt(Buffer.concat([Buffer.from([1]), pack.subarray(offset, offset + 65000)])));
  const delim = Buffer.from('0001');
  if (v2) {
    // A completed real Git fetch expects packfile directly; negotiating clients accept acknowledgments.
    const acknowledgments = lines.includes('done') ? [] : [pkt('acknowledgments\n'), pkt('NAK\n'), pkt('ready\n'), delim];
    return Buffer.concat([...acknowledgments, ...(shallowLines.length ? [pkt('shallow-info\n'), ...shallowLines, delim] : []), pkt('packfile\n'), ...bands, flush()]);
  }
  if (!v2 && Number.isFinite(requestedDepth) && !lines.includes('done') && !haves.length) return Buffer.concat([...shallowLines, flush()]);
  return Buffer.concat([...shallowLines, ...(Number.isFinite(requestedDepth) ? [flush()] : []), pkt('NAK\n'), ...bands, flush()]);
}
