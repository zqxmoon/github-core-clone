// mcp.ts — the Model Context Protocol endpoint at /mcp: JSON-RPC 2.0 over streamable HTTP.
// It speaks the modern revision (server/discover, no handshake) and the legacy handshake
// (initialize + notifications/initialized) alike; every answer is one JSON body. The tools
// are thin wrappers over the same forge operations REST and GraphQL use, so an object made
// over MCP is the same object over REST.

import { Repo, VIEWER_LOGIN, createIssue, createPull, forge, mergePull } from './forge.ts';
import { Ctx, Reply } from './http.ts';
import { issueJson, pullJson, repoJson } from './rest.ts';

const SERVER_INFO = { name: 'github-core-clone', version: '1.0.0' };
const SUPPORTED_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

interface ToolDef {
  name: string;
  description: string;
  properties: Record<string, { type: string; description: string }>;
  required: string[];
}

/** The tool list: built once, so two tools/list answers are byte-identical. */
const TOOLS: ToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a new repository for the authenticated user.',
    properties: {
      name: { type: 'string', description: 'The repository name.' },
      description: { type: 'string', description: 'A short description of the repository.' },
      private: { type: 'boolean', description: 'Whether the repository is private.' },
    },
    required: ['name'],
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    properties: {
      owner: { type: 'string', description: 'The repository owner login.' },
      repo: { type: 'string', description: 'The repository name.' },
    },
    required: ['owner', 'repo'],
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    properties: {
      owner: { type: 'string', description: 'The repository owner login.' },
      repo: { type: 'string', description: 'The repository name.' },
      title: { type: 'string', description: 'The issue title.' },
      body: { type: 'string', description: 'The issue body.' },
    },
    required: ['owner', 'repo', 'title'],
  },
  {
    name: 'list_issues',
    description: 'List the issues of a repository.',
    properties: {
      owner: { type: 'string', description: 'The repository owner login.' },
      repo: { type: 'string', description: 'The repository name.' },
      state: { type: 'string', description: 'Filter by state: open, closed or all.' },
    },
    required: ['owner', 'repo'],
  },
  {
    name: 'create_pull_request',
    description: 'Open a pull request from a head branch into a base branch.',
    properties: {
      owner: { type: 'string', description: 'The repository owner login.' },
      repo: { type: 'string', description: 'The repository name.' },
      title: { type: 'string', description: 'The pull request title.' },
      body: { type: 'string', description: 'The pull request body.' },
      head: { type: 'string', description: 'The head branch name.' },
      base: { type: 'string', description: 'The base branch name.' },
    },
    required: ['owner', 'repo', 'title', 'head', 'base'],
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request (squash).',
    properties: {
      owner: { type: 'string', description: 'The repository owner login.' },
      repo: { type: 'string', description: 'The repository name.' },
      pull_number: { type: 'number', description: 'The pull request number.' },
    },
    required: ['owner', 'repo', 'pull_number'],
  },
  {
    name: 'list_pull_requests',
    description: 'List the pull requests of a repository.',
    properties: {
      owner: { type: 'string', description: 'The repository owner login.' },
      repo: { type: 'string', description: 'The repository name.' },
      state: { type: 'string', description: 'Filter by state: open, closed or all.' },
    },
    required: ['owner', 'repo'],
  },
];

function toolListJson(): unknown {
  return {
    tools: TOOLS.map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: { type: 'object', properties: tool.properties, required: tool.required },
    })),
  };
}

function rpcResult(id: unknown, result: unknown): Reply {
  return { status: 200, body: { jsonrpc: '2.0', id: id ?? null, result } };
}

function rpcError(id: unknown, code: number, message: string, status = 200): Reply {
  return { status, body: { jsonrpc: '2.0', id: id ?? null, error: { code, message } } };
}

function toolSuccess(id: unknown, payload: unknown): Reply {
  const text = JSON.stringify(payload);
  return rpcResult(id, {
    content: [{ type: 'text', text }],
    structuredContent: payload,
    isError: false,
  });
}

function toolFailure(id: unknown, message: string): Reply {
  return rpcResult(id, {
    content: [{ type: 'text', text: message }],
    isError: true,
  });
}

function stringArg(args: Record<string, unknown>, name: string): string | null {
  const value = args[name];
  return typeof value === 'string' && value !== '' ? value : null;
}

function repoArg(args: Record<string, unknown>): Repo | null {
  const owner = stringArg(args, 'owner');
  const repo = stringArg(args, 'repo');
  if (owner === null || repo === null) return null;
  return forge.getRepo(owner, repo);
}

function callTool(id: unknown, name: string, args: Record<string, unknown>): Reply {
  const tool = TOOLS.find((candidate) => candidate.name === name);
  if (!tool) return rpcError(id, -32602, `Tool not found: ${name}`);
  for (const required of tool.required) {
    if (args[required] === undefined || args[required] === null || args[required] === '') {
      return rpcError(id, -32602, `Missing required argument: ${required}`);
    }
  }
  switch (name) {
    case 'create_repo': {
      const repoName = stringArg(args, 'name') as string;
      const existing = forge.getRepo(VIEWER_LOGIN, repoName);
      if (existing) return toolSuccess(id, repoJson(existing));
      const repo = forge.createRepo(
        VIEWER_LOGIN,
        repoName,
        args.private === true,
        typeof args.description === 'string' ? args.description : '',
      );
      if (!repo) return toolFailure(id, `repository ${repoName} already exists`);
      return toolSuccess(id, repoJson(repo));
    }
    case 'get_repo': {
      const repo = repoArg(args);
      if (!repo) return toolFailure(id, 'repository not found');
      return toolSuccess(id, repoJson(repo));
    }
    case 'create_issue': {
      const repo = repoArg(args);
      if (!repo) return toolFailure(id, 'repository not found');
      const result = createIssue(repo, stringArg(args, 'title') as string, typeof args.body === 'string' ? args.body : '', []);
      if ('error' in result) return toolFailure(id, result.error);
      return toolSuccess(id, issueJson(repo, result.issue));
    }
    case 'list_issues': {
      const repo = repoArg(args);
      if (!repo) return toolFailure(id, 'repository not found');
      const state = typeof args.state === 'string' ? args.state : 'open';
      let issues = [...repo.issues.values()];
      if (state === 'open' || state === 'closed') issues = issues.filter((issue) => issue.state === state);
      issues.sort((a, b) => b.number - a.number);
      return toolSuccess(id, issues.map((issue) => issueJson(repo, issue)));
    }
    case 'create_pull_request': {
      const repo = repoArg(args);
      if (!repo) return toolFailure(id, 'repository not found');
      const result = createPull(
        repo,
        stringArg(args, 'title') as string,
        typeof args.body === 'string' ? args.body : '',
        stringArg(args, 'head') as string,
        stringArg(args, 'base') as string,
      );
      if ('error' in result) return toolFailure(id, result.error);
      return toolSuccess(id, pullJson(repo, result.pull));
    }
    case 'merge_pull_request': {
      const repo = repoArg(args);
      if (!repo) return toolFailure(id, 'repository not found');
      const number = typeof args.pull_number === 'number' ? args.pull_number : Number(args.pull_number);
      const pull = repo.pulls.get(number);
      if (!pull) return toolFailure(id, 'pull request not found');
      const outcome = mergePull(repo, pull);
      if (!outcome.ok) return toolFailure(id, `merge failed: ${outcome.reason}`);
      return toolSuccess(id, pullJson(repo, pull));
    }
    case 'list_pull_requests': {
      const repo = repoArg(args);
      if (!repo) return toolFailure(id, 'repository not found');
      const state = typeof args.state === 'string' ? args.state : 'open';
      let pulls = [...repo.pulls.values()];
      if (state === 'open' || state === 'closed') pulls = pulls.filter((pull) => pull.state === state);
      pulls.sort((a, b) => b.number - a.number);
      return toolSuccess(id, pulls.map((pull) => pullJson(repo, pull)));
    }
    default:
      return rpcError(id, -32602, `Tool not found: ${name}`);
  }
}

/** Handle one POST /mcp. Auth is enforced by app.ts before this runs. */
export function handleMcp(ctx: Ctx): Reply {
  if (ctx.jsonError || ctx.json === undefined) {
    return rpcError(null, -32700, 'Parse error', 400);
  }
  const request = ctx.json as { id?: unknown; method?: unknown; params?: unknown };
  const id = request.id ?? null;
  const method = typeof request.method === 'string' ? request.method : '';
  const params = (request.params ?? {}) as Record<string, unknown>;

  if (method === 'server/discover') {
    return rpcResult(id, {
      resultType: 'complete',
      supportedVersions: SUPPORTED_VERSIONS,
      capabilities: { tools: {} },
      serverInfo: SERVER_INFO,
      instructions: 'A GitHub-compatible forge: repositories, issues and pull requests.',
    });
  }
  if (method === 'initialize') {
    const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : '2025-11-25';
    const protocolVersion = SUPPORTED_VERSIONS.includes(requested) ? requested : '2025-11-25';
    return rpcResult(id, { protocolVersion, capabilities: { tools: {} }, serverInfo: SERVER_INFO });
  }
  if (method === 'notifications/initialized' || method === 'notifications/cancelled') {
    return { status: 202 };
  }
  if (method === 'ping') return rpcResult(id, {});
  if (method === 'tools/list') return rpcResult(id, toolListJson());
  if (method === 'tools/call') {
    const name = typeof params.name === 'string' ? params.name : '';
    const args = (params.arguments ?? {}) as Record<string, unknown>;
    return callTool(id, name, args);
  }
  return rpcError(id, -32601, `Method not found: ${method}`);
}
