/**
 * Parse Claude Code and OpenCode session files
 *
 * Extracts structured data from raw session transcripts including:
 * - Token usage (total and per-model)
 * - User messages
 * - Tools used
 * - Files touched (from tool calls)
 * - Timestamps
 *
 * Supports both Claude Code JSONL format and OpenCode JSON export format
 */

import { readFileSync } from 'fs';
import type {
  SessionMessage,
  AssistantMessage,
  ParsedSession,
  ContentBlock,
  OpenCodeSession,
} from './types.js';

/**
 * Parse a single file - detects format automatically
 */
export function parseSessionFile(filePath: string): ParsedSession | null {
  const content = readFileSync(filePath, 'utf-8');
  
  // Try to detect format
  const trimmed = content.trim();
  
  // OpenCode JSON format (single JSON object)
  if (trimmed.startsWith('{') && trimmed.includes('"info"') && trimmed.includes('"messages"')) {
    try {
      const session = JSON.parse(trimmed) as OpenCodeSession;
      return parseOpenCodeSession(session);
    } catch {
      // Fall through to JSONL parsing
    }
  }
  
  // Claude Code JSONL format (newline-delimited JSON)
  return parseSessionContent(content, filePath);
}

/**
 * Parse JSONL content string into structured session data
 */
export function parseSessionContent(
  content: string,
  sessionId?: string
): ParsedSession | null {
  const lines = content.trim().split('\n').filter(Boolean);

  if (lines.length === 0) {
    return null;
  }

  const messages: SessionMessage[] = [];

  for (const line of lines) {
    try {
      const parsed = JSON.parse(line);
      // Only include user/assistant messages (skip summary, system, etc.)
      if (parsed.type === 'user' || parsed.type === 'assistant') {
        messages.push(parsed as SessionMessage);
      }
    } catch {
      // Skip malformed lines
      continue;
    }
  }

  if (messages.length === 0) {
    return null;
  }

  // Extract session metadata from first and last conversation messages
  const firstMessage = messages[0];
  const lastMessage = messages[messages.length - 1];

  // Initialize accumulators
  const userMessages: string[] = [];
  const toolsUsed = new Set<string>();
  const filesFromToolCalls = new Set<string>();
  const modelsUsed = new Set<string>();

  let inputTokens = 0;
  let outputTokens = 0;
  let cacheCreationTokens = 0;
  let cacheReadTokens = 0;

  const modelTokens: Record<
    string,
    { input: number; output: number; cacheCreation: number; cacheRead: number }
  > = {};

  for (const msg of messages) {
    if (msg.type === 'user') {
      // Extract user message text
      const userMsg = msg.message as { role: string; content: string };
      if (typeof userMsg.content === 'string' && userMsg.content.trim()) {
        userMessages.push(userMsg.content);
      }
    } else if (msg.type === 'assistant') {
      const assistantMsg = msg.message as AssistantMessage;

      // Track model
      if (assistantMsg.model) {
        modelsUsed.add(assistantMsg.model);

        // Initialize model token tracking
        if (!modelTokens[assistantMsg.model]) {
          modelTokens[assistantMsg.model] = {
            input: 0,
            output: 0,
            cacheCreation: 0,
            cacheRead: 0,
          };
        }
      }

      // Accumulate token usage
      if (assistantMsg.usage) {
        const usage = assistantMsg.usage;
        inputTokens += usage.input_tokens || 0;
        outputTokens += usage.output_tokens || 0;
        cacheCreationTokens += usage.cache_creation_input_tokens || 0;
        cacheReadTokens += usage.cache_read_input_tokens || 0;

        // Per-model tracking
        if (assistantMsg.model && modelTokens[assistantMsg.model]) {
          modelTokens[assistantMsg.model].input += usage.input_tokens || 0;
          modelTokens[assistantMsg.model].output += usage.output_tokens || 0;
          modelTokens[assistantMsg.model].cacheCreation +=
            usage.cache_creation_input_tokens || 0;
          modelTokens[assistantMsg.model].cacheRead +=
            usage.cache_read_input_tokens || 0;
        }
      }

      // Extract tools and files from content blocks
      if (Array.isArray(assistantMsg.content)) {
        for (const block of assistantMsg.content) {
          extractFromContentBlock(block, toolsUsed, filesFromToolCalls);
        }
      }
    }
  }

  // Derive session ID from file path or first message
  const id =
    sessionId?.match(/([a-f0-9-]{36})\.jsonl$/)?.[1] ||
    firstMessage.sessionId ||
    'unknown';

  return {
    id,
    startedAt: new Date(firstMessage.timestamp),
    endedAt: new Date(lastMessage.timestamp),
    gitBranch: firstMessage.gitBranch || 'unknown',
    cwd: firstMessage.cwd || '',
    version: firstMessage.version || '',
    messageCount: messages.length,

    inputTokens,
    outputTokens,
    cacheCreationTokens,
    cacheReadTokens,

    userMessages,
    toolsUsed: Array.from(toolsUsed),
    filesFromToolCalls: Array.from(filesFromToolCalls),
    modelsUsed: Array.from(modelsUsed),
    modelTokens,
    sessionType: 'claude-code',
  };
}

/**
 * Extract tool names and file paths from a content block
 */
function extractFromContentBlock(
  block: ContentBlock,
  toolsUsed: Set<string>,
  filesFromToolCalls: Set<string>
): void {
  if (block.type === 'tool_use' && block.name) {
    toolsUsed.add(block.name);

    // Extract file paths from tool inputs
    if (block.input) {
      extractFilePaths(block.input, filesFromToolCalls);
    }
  }
}

/**
 * Recursively extract file paths from tool input
 */
function extractFilePaths(
  input: Record<string, unknown>,
  files: Set<string>
): void {
  for (const [key, value] of Object.entries(input)) {
    // Common file path parameter names
    if (
      ['file_path', 'path', 'file', 'filename', 'filePath'].includes(key) &&
      typeof value === 'string'
    ) {
      // Only add if it looks like a path
      if (value.includes('/') || value.includes('\\')) {
        files.add(value);
      }
    }

    // Recurse into nested objects
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      extractFilePaths(value as Record<string, unknown>, files);
    }
  }
}

/**
 * Get a simple text summary suitable for search indexing
 */
export function getSearchableText(session: ParsedSession): string {
  const parts: string[] = [];

  // User messages are highest signal
  parts.push(...session.userMessages);

  // Tools and files provide context
  parts.push(...session.toolsUsed);
  parts.push(...session.filesFromToolCalls);

  return parts.join(' ');
}

/**
 * Parse OpenCode session export format
 */
export function parseOpenCodeSession(session: OpenCodeSession): ParsedSession {
  const toolsUsed = new Set<string>();
  const filesFromToolCalls = new Set<string>();
  const userMessages: string[] = [];
  const modelsUsed = new Set<string>();

  // Extract data from messages
  for (const message of session.messages) {
    // Collect user messages
    if (message.info.role === 'user' && message.parts) {
      for (const part of message.parts) {
        if (part.type === 'text' && part.text) {
          userMessages.push(part.text);
        }
      }
    }

    // Collect tool calls
    if (message.toolCalls) {
      for (const toolCall of message.toolCalls) {
        toolsUsed.add(toolCall.name);

        // Extract file paths from common tool parameters
        if (toolCall.parameters) {
          const params = toolCall.parameters;
          if (params.filePath) filesFromToolCalls.add(params.filePath);
          if (params.path) filesFromToolCalls.add(params.path);
          if (params.file) filesFromToolCalls.add(params.file);
        }
      }
    }

    // Collect models used
    if (message.info.model) {
      modelsUsed.add(message.info.model.modelID);
    }
  }

  return {
    id: session.info.id,
    startedAt: new Date(session.info.time.created),
    endedAt: new Date(session.info.time.updated),
    directory: session.info.directory,
    title: session.info.title || 'Untitled Session',
    messageCount: session.messages.length,
    toolsUsed: Array.from(toolsUsed),
    filesFromToolCalls: Array.from(filesFromToolCalls),
    userMessages,
    modelsUsed: Array.from(modelsUsed),
    inputTokens: 0, // OpenCode doesn't expose this in exports
    outputTokens: 0,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
    gitBranch: '',
    cwd: session.info.directory,
    version: '',
    modelTokens: {},
    sessionType: 'opencode',
  };
}
