# Kuato

Easily recall what you discussed with your favorite coding agents, what decisions you made, and where you left off so you can pick up where you left off as easily as asking "where did we leave off on XYZ..."

This simple, fully local session recall skill works with **Claude Code** and **OpenCode**. Instant use with text search, optional local postgres with faster and more accurate search on larger session histories. 

## The Problem

Claude Code and OpenCode forget everything between sessions. You're deep in a feature, close the tab, and the next day ask "where were we?" only to get a blank stare.

> **Kuato:** What do you want, Mr. Quaid?   
> **Quaid:** The same as you; to remember.   
> **Kuato:** But why?   
> **Quaid:** To be myself again.   
> **Kuato:** You are what you do. A man is defined by his actions, not his memory.   

Kuato gives Claude access to what you *did* - the actions that define your work.

## Two Versions

| Feature | File-Based | PostgreSQL |
|---------|------------|------------|
| **Setup time** | 0 minutes | 5 minutes |
| **Dependencies** | Bun only | Bun + Postgres |
| **Search speed** | ~1-5 seconds | <100ms |
| **Full-text search** | Basic matching | Weighted, ranked |
| **Fuzzy matching** | No | Yes (trigram) |
| **API server** | No | Yes |
| **Token tracking** | Yes | Yes + per-model |
| **Best for** | Quick lookups | Daily use |

**Start with file-based.** Upgrade to PostgreSQL when you're running 10+ sessions a day and want faster, smarter search.

## Quick Start: File-Based

Zero setup. Works directly with Claude Code's JSONL files or OpenCode sessions.

### Claude Code

```bash
# Clone the repo
git clone https://github.com/alexknowshtml/kuato.git
cd kuato

# Search your sessions
bun run file-based/search.ts --query "email system" --days 7

# Filter by tools used
bun run file-based/search.ts --tools Edit,Bash --limit 10

# Filter by file patterns
bun run file-based/search.ts --file-pattern "components/"
```

### OpenCode

```bash
# Search your OpenCode sessions
bun run file-based/search-opencode.ts --query "email system" --days 7

# Filter by tools used
bun run file-based/search-opencode.ts --tools edit,bash --limit 10

# Filter by file patterns
bun run file-based/search-opencode.ts --file-pattern "components/"
```

Output is JSON with all session metadata (both Claude Code and OpenCode):

```json
[
  {
    "id": "abc123-def456",
    "title": "Add email filtering system",  // OpenCode only
    "startedAt": "2025-01-15T10:30:00Z",
    "endedAt": "2025-01-15T11:45:00Z",
    "messageCount": 42,
    "toolsUsed": ["Edit", "Bash", "Read"],
    "filesFromToolCalls": ["src/api/email.ts", "src/utils/filter.ts"],
    "userMessages": [
      "Let's build an email filtering system",
      "Yes, use that approach",
      "Commit this and we'll continue tomorrow"
    ],
    "relevance": 23
  }
]
```

## Quick Start: PostgreSQL

One-command database setup, then sync and search sessions from both Claude Code and OpenCode.

```bash
cd kuato/postgres

# Start PostgreSQL (creates database + schema)
bun run db:up

# Install dependencies
bun install

# Sync Claude Code sessions
DATABASE_URL="postgres://claude:sessions@localhost:5433/claude_sessions" bun run sync

# OR sync OpenCode sessions
DATABASE_URL="postgres://claude:sessions@localhost:5433/claude_sessions" bun run sync-opencode

# OR sync both!
DATABASE_URL="postgres://claude:sessions@localhost:5433/claude_sessions" bun run sync
DATABASE_URL="postgres://claude:sessions@localhost:5433/claude_sessions" bun run sync-opencode

# Start API server
DATABASE_URL="postgres://claude:sessions@localhost:5433/claude_sessions" bun run serve
```

Then query the API:

```bash
# Search
curl "http://localhost:3847/sessions?search=email+filtering&days=7"

# Get single session
curl "http://localhost:3847/sessions/abc123-def456"

# With full transcript
curl "http://localhost:3847/sessions/abc123-def456?with_transcript=true"

# Statistics
curl "http://localhost:3847/sessions/stats?days=30"
```

## Using with Claude Code

The real power is teaching Claude how to search your history. Create a skill file:

```markdown
# Session Search

When the user asks "where did we leave off" or "what did we discuss about X":

1. Search sessions:
   curl "http://localhost:3847/sessions?search=TOPIC&days=14"

2. The results include `user_messages` - these tell the whole story
   (requests, confirmations, decisions)

3. Summarize what happened and offer to continue
```

See `shared/claude-skill.md` for a complete skill template.

## Using with OpenCode

OpenCode support is built-in. Use the file-based search scripts directly:

```bash
# Quick search
bun run file-based/search-opencode.ts --query "authentication" --days 7

# Or use the PostgreSQL API after syncing
curl "http://localhost:3847/sessions?search=authentication&days=7"
```

The existing OpenCode adapter in `opencode-adapter/search.ts` is now deprecated in favor of the unified approach, but still works if you prefer it.

## How It Works

### The Key Insight: User Messages

You don't need the full transcript to understand what happened. User messages are the signal:

- "Let's build an email filtering system" → Request
- "Yes, use that approach" → Decision
- "Actually, make it async" → Correction
- "Commit this" → Completion

Combined with `files_touched` and `tools_used`, you can reconstruct the session without loading 50k tokens.

### File-Based Search

Simple substring matching on user messages, tools, and file paths. Works with both Claude Code JSONL files and OpenCode sessions via the CLI.

**Claude Code:**
```
Query: "septa"
↓
Scan each JSONL file
↓
Check if "septa" appears in:
  - userMessages[]
  - toolsUsed[]
  - filesFromToolCalls[]
↓
Score by match count
↓
Return sorted results
```

**OpenCode:**
```
Query: "septa"
↓
List sessions via `opencode session list`
↓
Export each session via `opencode export`
↓
Check if "septa" appears in:
  - title
  - userMessages[]
  - toolsUsed[]
  - filesFromToolCalls[]
↓
Score by match count
↓
Return sorted results
```

**Pros:** Zero setup, no dependencies beyond Bun, works with both Claude Code and OpenCode  
**Cons:** Slower on large histories, no stemming ("running" won't match "run"), OpenCode requires CLI export (can be slow)

### PostgreSQL Search

Full-text search with linguistic processing using `tsvector` and `tsquery`. Works seamlessly with both Claude Code and OpenCode sessions once synced.

**Step 1: Text becomes tokens (tsvector)**

```sql
SELECT to_tsvector('english', 'The quick brown foxes are jumping');
-- Result: 'brown':3 'fox':4 'jump':5 'quick':2
```

Notice:
- **Stop words removed:** "The", "are" → gone
- **Stemming:** "foxes" → `fox`, "jumping" → `jump`
- **Positions tracked:** `fox:4` means 4th significant word

**Step 2: Queries match stems**

```sql
-- All of these match "The quick brown fox":
SELECT to_tsvector('english', 'The quick brown fox')
  @@ to_tsquery('english', 'foxes');      -- true (stems to fox)
  @@ to_tsquery('english', 'quick & brown'); -- true (AND)
  @@ to_tsquery('english', 'quick | cat');   -- true (OR)
```

**Step 3: Weights rank importance**

Sessions are indexed with weighted fields:

| Weight | Field | Priority |
|--------|-------|----------|
| A | `summary` | Highest (future use) |
| B | `search_text` | User messages |
| C | `tools_used`, `files_touched` | Tools and paths |
| D | `cwd` | Working directory |

```sql
-- "holiday" in user messages (B) ranks higher than in file path (C)
SELECT ts_rank(search_vector, to_tsquery('holiday')) FROM sessions;
```

**Step 4: GIN index makes it fast**

```sql
CREATE INDEX idx_sessions_search_vector ON sessions USING GIN(search_vector);
```

GIN (Generalized Inverted Index) is like a book index:
- Without index: scan every row → O(n)
- With GIN: lookup "holiday" → [session1, session5, session12] → O(log n)

**Step 5: File paths are tokenized**

Raw paths like `/Users/alex/septa-holiday-bus/App.jsx` become searchable tokens:

```sql
-- We transform: '/path/to/septa-holiday/' → 'path to septa holiday'
regexp_replace(path, '[/\-_.]', ' ', 'g')
```

So searching "septa" finds sessions that touched files in `septa-*` directories.

**Speed comparison:**
- File-based: ~150ms (substring scan)
- PostgreSQL: ~30ms (index lookup)

The gap grows with session count. At 1000+ sessions, PostgreSQL is 10-50x faster.

## API Reference (PostgreSQL)

### GET /sessions

Search sessions with filters.

| Param | Description |
|-------|-------------|
| `search` | Full-text search (weighted: summary > messages > tools) |
| `days` | Last N days only |
| `since` | Sessions after date (YYYY-MM-DD) |
| `until` | Sessions before date |
| `tools` | Filter by tool names (comma-separated) |
| `file_pattern` | Filter by file path pattern |
| `limit` | Max results (default 20, max 100) |

### GET /sessions/:id

Get single session. Add `?with_transcript=true` for full messages.

### GET /sessions/stats

Usage statistics. Add `?days=30` to customize window.

Returns: session count, token totals, breakdown by model.

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `CLAUDE_SESSIONS_DIR` | `~/.claude/projects` | Where Claude Code stores sessions |
| `DATABASE_URL` | `postgres://localhost/claude_sessions` | PostgreSQL connection |
| `PORT` | `3847` | API server port |

Note: OpenCode sessions are accessed via the `opencode` CLI and don't require a directory path.

## Tips

### Scheduled Sync

Run sync every 15 minutes to keep the database current:

**Claude Code:**
```bash
# crontab -e
*/15 * * * * cd /path/to/kuato/postgres && DATABASE_URL="..." bun run sync >> /var/log/kuato-sync.log 2>&1
```

**OpenCode:**
```bash
# crontab -e
*/15 * * * * cd /path/to/kuato/postgres && DATABASE_URL="..." bun run sync-opencode >> /var/log/kuato-sync-opencode.log 2>&1
```

**Both:**
```bash
# crontab -e
*/15 * * * * cd /path/to/kuato/postgres && DATABASE_URL="..." bun run sync && bun run sync-opencode >> /var/log/kuato-sync-all.log 2>&1
```

### Search Strategies

**By topic:**
```bash
curl "http://localhost:3847/sessions?search=authentication"
```

**By file:**
```bash
curl "http://localhost:3847/sessions?file_pattern=src/auth"
```

**Recent activity:**
```bash
curl "http://localhost:3847/sessions?days=3&limit=50"
```

**Combined:**
```bash
curl "http://localhost:3847/sessions?search=refactor&tools=Edit&days=7"
```

## Technical Details

### OpenCode vs Claude Code

Both are now fully supported with identical search capabilities:

| Feature | Claude Code | OpenCode |
|---------|-------------|----------|
| **Access Method** | Direct JSONL file reading | CLI (`opencode export`) |
| **Session Titles** | No | Yes |
| **Token Tracking** | Full (input/output/cache) | Not exposed (set to 0) |
| **Git Branch** | Yes | No |
| **File Parsing** | JSONL (newline-delimited) | JSON (single object) |

### Unified Schema

Both formats are normalized to the same internal structure:

```typescript
interface ParsedSession {
  id: string;
  title?: string;              // OpenCode only
  startedAt: Date;
  endedAt: Date;
  cwd: string;                 // Working directory
  userMessages: string[];      // What the user said
  toolsUsed: string[];         // Tools called (Edit, Bash, etc)
  filesFromToolCalls: string[]; // Files touched
  modelsUsed: string[];        // AI models used
  sessionType?: 'claude-code' | 'opencode';
}
```

This allows seamless searching across both sources using the same API.

### Implementation Files

**New:**
- `file-based/search-opencode.ts` - OpenCode CLI-based search
- `postgres/sync-opencode.ts` - OpenCode PostgreSQL sync

**Modified:**
- `shared/parser.ts` - Added `parseOpenCodeSession()` and format auto-detection
- `shared/types.ts` - Added `OpenCodeSession` interface

**Package Scripts:**
- `bun run search:opencode` - Search OpenCode sessions (file-based)
- `bun run sync:opencode` - Sync OpenCode to PostgreSQL

All existing Claude Code functionality remains unchanged and fully compatible.

## Contributing

Issues and PRs welcome. This started as a personal tool - feedback on what's useful appreciated.

## License

MIT
