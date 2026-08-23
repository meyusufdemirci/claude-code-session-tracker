import type {
  SessionContextDetail,
  SessionContextPart,
  SessionContextPartUsage,
  SessionTokenTotals,
} from '../../core/types.ts';
import { contextWindowFor } from './models.ts';

/**
 * Characters to a token.
 *
 * Deliberately on the high side. Claude's tokenizer runs nearer 3.5 characters to
 * the token on the markdown and code these blocks hold, so dividing by four
 * understates every named row a little — and understating is the safe direction
 * here: each row is only ever a claim about text we actually read, and the unnamed
 * remainder absorbs the difference instead of going negative.
 */
const CHARS_PER_TOKEN = 4;

/** A slice of the static block we could read, before it is priced in tokens. */
export interface StaticSlice {
  part: SessionContextPart;
  label: string;
  chars: number;
}

/**
 * What one pre-first-turn attachment put into the window.
 *
 * Returns nothing for the attachments that cost the window nothing — an IDE saying
 * which file is open, a permissions note — and for any type added to the format
 * after this was written, which is the case that has to stay quiet.
 */
export function staticSliceOf(value: unknown): StaticSlice | undefined {
  const attachment = obj(value);
  if (!attachment) return undefined;

  switch (str(attachment.type)) {
    case 'nested_memory': {
      // Nested one deeper than every other attachment: `content` is the memory
      // *file*, whose own `content` is the markdown that was inlined.
      const file = obj(attachment.content);
      const text = str(file?.content);
      if (!text) return undefined;
      const label = str(attachment.displayPath) ?? str(attachment.path) ?? 'Memory file';
      return { part: 'memory', label, chars: text.length };
    }

    case 'skill_listing': {
      const text = str(attachment.content);
      if (!text) return undefined;
      return { part: 'skills', label: countedLabel('Skills', attachment.names), chars: text.length };
    }

    case 'deferred_tools_delta': {
      const chars = joinedLength(attachment.addedLines);
      if (chars === 0) return undefined;
      return { part: 'tools', label: countedLabel('Deferred tools', attachment.addedNames), chars };
    }

    case 'agent_listing_delta': {
      const chars = joinedLength(attachment.addedLines);
      if (chars === 0) return undefined;
      return { part: 'agents', label: countedLabel('Agent listing', attachment.addedTypes), chars };
    }

    case 'mcp_instructions_delta': {
      const chars = joinedLength(attachment.addedBlocks);
      if (chars === 0) return undefined;
      return { part: 'mcp', label: countedLabel('MCP instructions', attachment.addedNames), chars };
    }

    default:
      return undefined;
  }
}

/**
 * A snapshot of how full the window is, and what the static half of it is made of.
 *
 * `first` stands in for the static block — system prompt, tool schemas, memory
 * files, listings — and `last` for what the window holds now.
 */
export function buildContext(
  first: SessionTokenTotals | undefined,
  last: SessionTokenTotals,
  model: string | undefined,
  slices: readonly StaticSlice[],
): SessionContextDetail {
  const current = last.input + last.cacheRead + last.cacheCreate;
  // Capped at `current`: a `/clear` or compaction partway through the transcript can
  // leave the first turn's cache write larger than what the window holds now.
  const staticTokens = Math.min(first?.cacheCreate ?? 0, current);
  const conversationTokens = current - staticTokens;
  const windowTokens = contextWindowFor(model);

  return {
    staticTokens,
    conversationTokens,
    staticParts: priceSlices(slices, staticTokens),
    ...(windowTokens !== undefined ? { windowTokens, freeTokens: Math.max(0, windowTokens - current) } : {}),
  };
}

/**
 * Turns measured characters into the rows the panel shows.
 *
 * Two things happen here that the raw sizes cannot do on their own. Slices sharing
 * a label are merged, since a listing can be written as more than one delta before
 * the first turn ever runs. And the rows are made to add up to `staticTokens`:
 * whatever they do not account for becomes the `rest` row, because the base system
 * prompt and the built-in tool schemas are never written to disk and would
 * otherwise be a silent majority of the block.
 */
function priceSlices(slices: readonly StaticSlice[], staticTokens: number): SessionContextPartUsage[] {
  if (staticTokens === 0) return [];

  const merged = new Map<string, SessionContextPartUsage>();
  for (const slice of slices) {
    const key = `${slice.part} ${slice.label}`;
    const existing = merged.get(key);
    const tokens = Math.round(slice.chars / CHARS_PER_TOKEN);
    if (existing) existing.tokens += tokens;
    else merged.set(key, { part: slice.part, label: slice.label, tokens });
  }

  const parts = [...merged.values()].filter((entry) => entry.tokens > 0);
  let named = parts.reduce((sum, entry) => sum + entry.tokens, 0);

  // An estimate can outrun the measurement — a memory file heavy in prose tokenizes
  // above four characters a token. Scale back to fit rather than report a static
  // block larger than the one the session paid for.
  if (named > staticTokens) {
    const scale = staticTokens / named;
    for (const entry of parts) entry.tokens = Math.round(entry.tokens * scale);
    named = parts.reduce((sum, entry) => sum + entry.tokens, 0);
  }

  parts.sort((a, b) => b.tokens - a.tokens);

  // Last, however large: the one row nobody can act on, and the only one derived
  // rather than read.
  const rest = staticTokens - named;
  if (rest > 0) parts.push({ part: 'rest', label: 'System prompt + tool schemas', tokens: rest });

  return parts;
}

/** `Skills (79)` — the listing's name, with however many things it names. */
function countedLabel(name: string, names: unknown): string {
  return Array.isArray(names) && names.length > 0 ? `${name} (${names.length})` : name;
}

/** These arrive as an array of lines or blocks; the window sees them joined. */
function joinedLength(value: unknown): number {
  if (!Array.isArray(value)) return 0;
  let total = 0;
  for (const entry of value) {
    total += (typeof entry === 'string' ? entry : JSON.stringify(entry ?? '')).length + 1;
  }
  return total;
}

function obj(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}
