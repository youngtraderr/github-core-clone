import { deriveViewerLogin } from './scenario.ts';

export type Issue = { id?: number; created_seq?: number; created_at?: string; updated_at?: string; number: number; title: string; body: string; state: string; user: { login: string }; labels: unknown[]; comments: number };
export type PullRequest = Issue & { head: { ref: string; sha?: string }; base: { ref: string; sha?: string }; merged: boolean; merged_at?: string; merge_commit_sha?: string; mergedAt?: string; mergeCommitSha?: string };
export type Repository = { id: number; owner: { login: string }; name: string; full_name: string; description: string; private: boolean; default_branch: string; issues: Map<number, Issue>; labels: Map<string, unknown>; pull_requests: Map<number, PullRequest>; comments: Map<number, unknown[]>; files: Map<string, string>; counter: number };
export type ForgeStore = { repos: Map<string, Repository>; objects: Map<string, Buffer>; refs: Map<string, string>; nextRequest: number; nextRepo: number; login: string; token: string };
export function createStore(): ForgeStore {
  return { repos: new Map(), objects: new Map(), refs: new Map(), nextRequest: 1, nextRepo: 1, login: process.env.MAKEFUN_GITHUB_LOGIN || deriveViewerLogin(), token: process.env.MAKEFUN_SHOP_TOKEN || 'test-token' };
}
export const repoKey = (owner: string, name: string) => `${owner}/${name}`;
export function getRepo(s: ForgeStore, owner: string, name: string): Repository | undefined { return s.repos.get(repoKey(owner, name)); }
export function createRepo(s: ForgeStore, owner: string, name: string, description = '', privateRepo = false): Repository {
  const key = repoKey(owner, name);
  const old = s.repos.get(key);
  if (old) return old;
  const repo: Repository = { id: s.nextRepo++, owner: { login: owner }, name, full_name: key, description, private: privateRepo, default_branch: 'main', issues: new Map(), labels: new Map(), pull_requests: new Map(), comments: new Map(), files: new Map(), counter: 1 };
  s.repos.set(key, repo); return repo;
}
export function nextId(repo: Repository): number { return repo.counter++; }
export function objectKey(owner: string, name: string, path: string): string { return `${owner}/${name}:${path}`; }
export function refKey(owner: string, name: string, ref: string): string { return `${owner}/${name}:${ref}`; }
export function issueJson(i: Issue): Issue { return structuredClone(i); }
