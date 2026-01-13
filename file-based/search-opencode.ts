#!/usr/bin/env bun
/**
 * File-based session search for OpenCode
 *
 * Usage:
 *   bun run file-based/search-opencode.ts --query "email system" --days 7
 *   bun run file-based/search-opencode.ts --tools Edit,Bash --limit 10
 *
 * Output: JSON array of matching sessions
 */

import { execSync } from 'child_process';
import { parseArgs } from 'util';
import { parseOpenCodeSession } from '../shared/parser.js';
import type { OpenCodeSession, ParsedSession, SearchResult, SearchOptions } from '../shared/types.js';

/**
 * Get list of all OpenCode sessions
 */
function getAllSessionIDs(): string[] {
  try {
    const output = execSync('opencode session list --format json', {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'ignore'],
    });
    
    const lines = output.trim().split('\n');
    const sessionIDs: string[] = [];
    
    for (const line of lines) {
      const match = line.match(/ses_[a-zA-Z0-9]+/);
      if (match) {
        sessionIDs.push(match[0]);
      }
    }
    
    return sessionIDs;
  } catch (error) {
    console.error('Error listing sessions:', error);
    return [];
  }
}

/**
 * Export a single session
 */
function exportSession(sessionID: string): OpenCodeSession | null {
  try {
    const output = execSync(`opencode export ${sessionID}`, {
      encoding: 'utf-8',
      maxBuffer: 10 * 1024 * 1024, // 10MB
    });
    return JSON.parse(output);
  } catch {
    return null;
  }
}

/**
 * Score relevance of a session against search query
 */
function scoreRelevance(session: ParsedSession, query: string): number {
  if (!query) return 1;

  const queryLower = query.toLowerCase();
  const queryTerms = queryLower.split(/\s+/).filter(Boolean);
  let score = 0;

  // Title has highest weight (OpenCode specific)
  if (session.title) {
    const titleLower = session.title.toLowerCase();
    for (const term of queryTerms) {
      if (titleLower.includes(term)) {
        score += 15;
      }
    }
  }

  // User messages have high weight
  for (const msg of session.userMessages) {
    const msgLower = msg.toLowerCase();
    for (const term of queryTerms) {
      if (msgLower.includes(term)) {
        score += 10;
      }
    }
  }

  // Directory path has medium weight
  const dirLower = session.cwd.toLowerCase();
  for (const term of queryTerms) {
    if (dirLower.includes(term)) {
      score += 5;
    }
  }

  // Tools used have medium weight
  for (const tool of session.toolsUsed) {
    const toolLower = tool.toLowerCase();
    for (const term of queryTerms) {
      if (toolLower.includes(term)) {
        score += 3;
      }
    }
  }

  // Files touched have medium weight
  for (const file of session.filesFromToolCalls) {
    const fileLower = file.toLowerCase();
    for (const term of queryTerms) {
      if (fileLower.includes(term)) {
        score += 3;
      }
    }
  }

  return score;
}

/**
 * Check if session matches filter criteria
 */
function matchesFilters(session: ParsedSession, options: SearchOptions): boolean {
  // Filter by date range
  if (options.since && session.endedAt < options.since) return false;
  if (options.until && session.endedAt > options.until) return false;
  if (options.days) {
    const cutoff = new Date(Date.now() - options.days * 24 * 60 * 60 * 1000);
    if (session.endedAt < cutoff) return false;
  }

  // Filter by tools
  if (options.tools && options.tools.length > 0) {
    const hasMatchingTool = options.tools.some((tool) =>
      session.toolsUsed.some((t) => t.toLowerCase().includes(tool.toLowerCase()))
    );
    if (!hasMatchingTool) return false;
  }

  // Filter by file pattern
  if (options.filePattern) {
    const pattern = options.filePattern.toLowerCase();
    const hasMatchingFile = session.filesFromToolCalls.some((f) =>
      f.toLowerCase().includes(pattern)
    );
    if (!hasMatchingFile) return false;
  }

  return true;
}

/**
 * Search all OpenCode sessions
 */
function searchSessions(options: SearchOptions): SearchResult[] {
  console.error('Fetching session list...');
  const sessionIDs = getAllSessionIDs();
  console.error(`Found ${sessionIDs.length} sessions`);

  const results: SearchResult[] = [];

  for (let i = 0; i < sessionIDs.length; i++) {
    const sessionID = sessionIDs[i];
    console.error(`Processing ${i + 1}/${sessionIDs.length}: ${sessionID}`);

    const rawSession = exportSession(sessionID);
    if (!rawSession) continue;

    const session = parseOpenCodeSession(rawSession);

    // Skip empty sessions
    if (session.userMessages.length === 0) continue;

    // Apply filters
    if (!matchesFilters(session, options)) continue;

    // Score relevance if query provided
    const relevance = options.query ? scoreRelevance(session, options.query) : 1;

    // Skip zero-relevance matches when searching
    if (options.query && relevance === 0) continue;

    results.push({
      ...session,
      relevance,
    });
  }

  // Sort by relevance (desc), then by date (desc)
  results.sort((a, b) => {
    if (a.relevance !== b.relevance) {
      return (b.relevance || 0) - (a.relevance || 0);
    }
    return b.endedAt.getTime() - a.endedAt.getTime();
  });

  // Apply limit
  const limit = options.limit || 20;
  return results.slice(0, limit);
}

/**
 * Format results for output
 */
function formatResults(results: SearchResult[]): object[] {
  return results.map((r) => ({
    id: r.id,
    title: r.title,
    directory: r.cwd,
    startedAt: r.startedAt.toISOString(),
    endedAt: r.endedAt.toISOString(),
    messageCount: r.messageCount,
    toolsUsed: r.toolsUsed,
    filesFromToolCalls: r.filesFromToolCalls,
    userMessages: r.userMessages,
    modelsUsed: r.modelsUsed,
    relevance: r.relevance,
  }));
}

// CLI entry point
async function main() {
  const { values } = parseArgs({
    options: {
      query: { type: 'string', short: 'q' },
      days: { type: 'string', short: 'd' },
      since: { type: 'string' },
      until: { type: 'string' },
      tools: { type: 'string', short: 't' },
      'file-pattern': { type: 'string', short: 'f' },
      limit: { type: 'string', short: 'l' },
      help: { type: 'boolean', short: 'h' },
    },
    allowPositionals: true,
  });

  if (values.help) {
    console.log(`
OpenCode Session Search (File-based)

Usage:
  bun run search-opencode.ts [options]

Options:
  -q, --query <text>        Search sessions by text
  -d, --days <n>            Limit to last N days
  --since <date>            Sessions after this date (YYYY-MM-DD)
  --until <date>            Sessions before this date (YYYY-MM-DD)
  -t, --tools <list>        Filter by tools (comma-separated)
  -f, --file-pattern <pat>  Filter by file path pattern
  -l, --limit <n>           Max results (default: 20)
  -h, --help                Show this help

Examples:
  bun run search-opencode.ts --query "email filtering" --days 7
  bun run search-opencode.ts --tools Edit,Bash --limit 10
  bun run search-opencode.ts --file-pattern "components/"
`);
    process.exit(0);
  }

  const options: SearchOptions = {
    query: values.query,
    days: values.days ? parseInt(values.days, 10) : undefined,
    since: values.since ? new Date(values.since) : undefined,
    until: values.until ? new Date(values.until) : undefined,
    tools: values.tools ? values.tools.split(',') : undefined,
    filePattern: values['file-pattern'],
    limit: values.limit ? parseInt(values.limit, 10) : 20,
  };

  const results = searchSessions(options);
  const formatted = formatResults(results);

  console.log(JSON.stringify(formatted, null, 2));
}

main().catch(console.error);
