#!/usr/bin/env bun
/**
 * Sync OpenCode sessions to PostgreSQL
 *
 * Usage:
 *   bun run postgres/sync-opencode.ts                    # Incremental sync (new/changed)
 *   bun run postgres/sync-opencode.ts --all              # Full sync
 *   bun run postgres/sync-opencode.ts --days 7           # Last 7 days only
 *   bun run postgres/sync-opencode.ts --force            # Re-sync even if unchanged
 *
 * Environment:
 *   DATABASE_URL   - PostgreSQL connection string
 */

import { execSync } from 'child_process';
import { createHash } from 'crypto';
import { parseArgs } from 'util';
import postgres from 'postgres';
import { parseOpenCodeSession } from '../shared/parser.js';
import type { OpenCodeSession, ParsedSession } from '../shared/types.js';

// Configuration
const DATABASE_URL = process.env.DATABASE_URL || 'postgres://localhost/claude_sessions';

// Connect to database
const sql = postgres(DATABASE_URL);

interface SyncOptions {
  all?: boolean;
  days?: number;
  force?: boolean;
  limit?: number;
}

interface SyncStats {
  created: number;
  updated: number;
  skipped: number;
  errors: number;
}

/**
 * Get list of all OpenCode sessions
 */
function getAllSessionIDs(options: SyncOptions): string[] {
  try {
    const maxCount = options.limit ? `--max-count ${options.limit}` : '';
    const output = execSync(`opencode session list --format json ${maxCount}`, {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'ignore'],
    });
    
    // Parse the list output
    const lines = output.trim().split('\n');
    const sessionIDs: string[] = [];
    
    for (const line of lines) {
      // Match session IDs that start with "ses_"
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
 * Calculate hash of session data
 */
function sessionHash(session: OpenCodeSession): string {
  const content = JSON.stringify(session);
  return createHash('md5').update(content).digest('hex');
}

/**
 * Get existing session hashes from database
 */
async function getExistingHashes(): Promise<Map<string, string>> {
  const rows = await sql`
    SELECT id, transcript_hash FROM sessions WHERE transcript_hash IS NOT NULL
  `;
  return new Map(rows.map((r) => [r.id, r.transcript_hash]));
}

/**
 * Check if session matches date filter
 */
function matchesDateFilter(session: ParsedSession, options: SyncOptions): boolean {
  if (!options.days) return true;
  
  const cutoffDate = new Date(Date.now() - options.days * 24 * 60 * 60 * 1000);
  return session.endedAt >= cutoffDate;
}

/**
 * Sync a single session to the database
 */
async function syncSession(
  sessionID: string,
  existingHashes: Map<string, string>,
  options: SyncOptions
): Promise<'created' | 'updated' | 'skipped' | 'error'> {
  try {
    // Export session
    const rawSession = exportSession(sessionID);
    if (!rawSession) {
      return 'error';
    }

    // Parse session
    const session = parseOpenCodeSession(rawSession);
    if (!session) {
      return 'skipped';
    }

    // Skip empty sessions
    if (session.userMessages.length === 0) {
      return 'skipped';
    }

    // Apply date filter
    if (!matchesDateFilter(session, options)) {
      return 'skipped';
    }

    // Check if already synced with same hash
    const hash = sessionHash(rawSession);
    const existingHash = existingHashes.get(session.id);

    if (existingHash === hash && !options.force) {
      return 'skipped';
    }

    // Build search text from title and user messages
    const searchText = [
      session.title || '',
      ...session.userMessages,
    ].join(' ');

    // Upsert session
    await sql`
      INSERT INTO sessions (
        id,
        started_at,
        ended_at,
        git_branch,
        cwd,
        version,
        message_count,
        input_tokens,
        output_tokens,
        cache_creation_tokens,
        cache_read_tokens,
        user_messages,
        tools_used,
        files_touched,
        models_used,
        model_tokens,
        search_text,
        summary,
        transcript_hash,
        synced_at
      ) VALUES (
        ${session.id},
        ${session.startedAt},
        ${session.endedAt},
        ${session.gitBranch || ''},
        ${session.cwd},
        ${session.version || 'opencode'},
        ${session.messageCount},
        ${session.inputTokens},
        ${session.outputTokens},
        ${session.cacheCreationTokens},
        ${session.cacheReadTokens},
        ${sql.json(session.userMessages)},
        ${sql.json(session.toolsUsed)},
        ${sql.json(session.filesFromToolCalls)},
        ${sql.json(session.modelsUsed)},
        ${sql.json(session.modelTokens)},
        ${searchText},
        ${session.title || ''},
        ${hash},
        NOW()
      )
      ON CONFLICT (id) DO UPDATE SET
        started_at = EXCLUDED.started_at,
        ended_at = EXCLUDED.ended_at,
        git_branch = EXCLUDED.git_branch,
        cwd = EXCLUDED.cwd,
        version = EXCLUDED.version,
        message_count = EXCLUDED.message_count,
        input_tokens = EXCLUDED.input_tokens,
        output_tokens = EXCLUDED.output_tokens,
        cache_creation_tokens = EXCLUDED.cache_creation_tokens,
        cache_read_tokens = EXCLUDED.cache_read_tokens,
        user_messages = EXCLUDED.user_messages,
        tools_used = EXCLUDED.tools_used,
        files_touched = EXCLUDED.files_touched,
        models_used = EXCLUDED.models_used,
        model_tokens = EXCLUDED.model_tokens,
        search_text = EXCLUDED.search_text,
        summary = EXCLUDED.summary,
        transcript_hash = EXCLUDED.transcript_hash,
        synced_at = NOW()
    `;

    return existingHash ? 'updated' : 'created';
  } catch (error) {
    console.error(`Error syncing ${sessionID}:`, error);
    return 'error';
  }
}

/**
 * Main sync function
 */
async function sync(options: SyncOptions): Promise<SyncStats> {
  const stats: SyncStats = {
    created: 0,
    updated: 0,
    skipped: 0,
    errors: 0,
  };

  console.log('Syncing OpenCode sessions to PostgreSQL');

  // Get existing hashes for change detection
  const existingHashes = await getExistingHashes();
  console.log(`Found ${existingHashes.size} existing sessions in database`);

  // Get session list
  const sessionIDs = getAllSessionIDs(options);
  console.log(`Found ${sessionIDs.length} OpenCode sessions to process`);

  // Process each session
  for (let i = 0; i < sessionIDs.length; i++) {
    const sessionID = sessionIDs[i];
    console.error(`Processing ${i + 1}/${sessionIDs.length}: ${sessionID}`);
    
    const result = await syncSession(sessionID, existingHashes, options);
    stats[result]++;

    if (result !== 'skipped') {
      console.log(`  ${result}: ${sessionID}`);
    }
  }

  return stats;
}

// CLI entry point
async function main() {
  const { values } = parseArgs({
    options: {
      all: { type: 'boolean', short: 'a' },
      days: { type: 'string', short: 'd' },
      force: { type: 'boolean', short: 'f' },
      limit: { type: 'string', short: 'l' },
      help: { type: 'boolean', short: 'h' },
    },
  });

  if (values.help) {
    console.log(`
OpenCode Session Sync (PostgreSQL)

Usage:
  bun run sync-opencode.ts [options]

Options:
  -a, --all              Sync all sessions (not just recent)
  -d, --days <n>         Only sync last N days
  -f, --force            Re-sync even if unchanged
  -l, --limit <n>        Max sessions to process
  -h, --help             Show this help

Environment:
  DATABASE_URL           PostgreSQL connection string

Examples:
  bun run sync-opencode.ts                    # Incremental sync
  bun run sync-opencode.ts --all              # Full sync
  bun run sync-opencode.ts --days 7           # Last week only
  bun run sync-opencode.ts --force            # Force re-sync
`);
    process.exit(0);
  }

  const options: SyncOptions = {
    all: values.all,
    days: values.days ? parseInt(values.days, 10) : undefined,
    force: values.force,
    limit: values.limit ? parseInt(values.limit, 10) : undefined,
  };

  try {
    const stats = await sync(options);

    console.log('\nSync complete:');
    console.log(`  Created: ${stats.created}`);
    console.log(`  Updated: ${stats.updated}`);
    console.log(`  Skipped: ${stats.skipped}`);
    console.log(`  Errors:  ${stats.errors}`);
  } finally {
    await sql.end();
  }
}

main().catch((error) => {
  console.error('Sync failed:', error);
  process.exit(1);
});
