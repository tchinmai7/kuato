/**
 * Types for Claude Code and OpenCode session formats
 */

// ===== Claude Code JSONL Format =====

export interface SessionMessage {
  parentUuid: string | null;
  isSidechain: boolean;
  userType: 'external' | 'internal';
  cwd: string;
  sessionId: string;
  version: string;
  gitBranch: string;
  type: 'user' | 'assistant';
  message: UserMessage | AssistantMessage;
  uuid: string;
  timestamp: string;
  requestId?: string;
}

export interface UserMessage {
  role: 'user';
  content: string;
}

export interface AssistantMessage {
  role: 'assistant';
  content: ContentBlock[];
  id: string;
  model: string;
  stop_reason: string;
  stop_sequence: string | null;
  type: 'message';
  usage: TokenUsage;
}

export interface ContentBlock {
  type: 'text' | 'tool_use' | 'tool_result';
  text?: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
}

export interface TokenUsage {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
  cache_creation?: {
    ephemeral_5m_input_tokens: number;
    ephemeral_1h_input_tokens: number;
  };
  service_tier?: string;
}

// ===== OpenCode Export Format =====

export interface OpenCodeSession {
  info: {
    id: string;
    directory: string;
    title: string;
    time: {
      created: number;
      updated: number;
    };
    summary?: {
      additions: number;
      deletions: number;
      files: number;
    };
  };
  messages: Array<{
    info: {
      id: string;
      role: 'user' | 'assistant';
      time: { created: number };
      agent?: string;
      model?: {
        providerID: string;
        modelID: string;
      };
    };
    parts?: Array<{
      type: string;
      text?: string;
    }>;
    toolCalls?: Array<{
      name: string;
      parameters?: any;
    }>;
  }>;
}

/**
 * Parsed session data extracted from JSONL (unified for both Claude Code and OpenCode)
 */
export interface ParsedSession {
  id: string;
  startedAt: Date;
  endedAt: Date;
  gitBranch: string;
  cwd: string;
  version: string;
  messageCount: number;

  // Token totals
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;

  // Extracted data
  userMessages: string[];
  toolsUsed: string[];
  filesFromToolCalls: string[];
  modelsUsed: string[];

  // Per-model token breakdown
  modelTokens: Record<string, {
    input: number;
    output: number;
    cacheCreation: number;
    cacheRead: number;
  }>;

  // Optional fields
  title?: string; // OpenCode has titles
  sessionType?: 'claude-code' | 'opencode'; // Track source
}

/**
 * Search result with relevance scoring
 */
export interface SearchResult extends ParsedSession {
  relevance?: number;
  matchedOn?: string[];
  transcriptPath?: string;
}

/**
 * Search options
 */
export interface SearchOptions {
  query?: string;
  days?: number;
  since?: Date;
  until?: Date;
  tools?: string[];
  filePattern?: string;
  limit?: number;
}
