import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult, ToolAnnotations } from '@modelcontextprotocol/sdk/types.js';
import { z, type ZodRawShape } from 'zod';
import { ConfirmationRequired, hideSecrets, type WriteGuard } from './safety.js';

/** What every tool module registers against. */
export type ToolHost = { server: McpServer; guard: WriteGuard };

export type ToolContext = {
  /**
   * Gate a write behind the user's confirmation. Resolves when it may go
   * ahead; otherwise the call ends with the confirmation request.
   */
  confirm(summary: string): Promise<void>;
};

export type Pagination = {
  total: number;
  count: number;
  offset: number;
  has_more: boolean;
  next_offset?: number;
};

export type Table = {
  headers: string[];
  rows: unknown[][];
};

/** What a tool handler returns; the wrapper renders it as markdown or JSON. */
export type ToolOutput = {
  data: unknown;
  pagination?: Pagination;
  /** Plain lines shown under the title in markdown mode. */
  summary?: string[];
  /** Markdown tables; without one the markdown view falls back to a JSON dump. */
  tables?: Array<Table & { title?: string }>;
};

export const READ_ONLY: ToolAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
};

export const WRITE = (opts: { destructive: boolean; idempotent: boolean }): ToolAnnotations => ({
  readOnlyHint: false,
  destructiveHint: opts.destructive,
  idempotentHint: opts.idempotent,
  openWorldHint: true,
});

const responseFormat = z
  .enum(['markdown', 'json'])
  .default('markdown')
  .describe('Output format: markdown (readable tables) or json (default: markdown)');

type ToolArgs<S extends ZodRawShape> = z.objectOutputType<S, z.ZodTypeAny>;

const confirmationToken = z
  .string()
  .optional()
  .describe('Only when a previous call returned one, and only after the user confirmed they have a backup');

/**
 * Registers a tool whose schema is the single source of truth: the SDK derives
 * the advertised JSON schema from it and validates arguments against it before
 * the handler runs. Every tool gets `response_format` and the same error shape.
 *
 * Tools not annotated read-only are writes. By default the whole call is
 * confirmed before the handler runs; with `confirm: 'manual'` the handler
 * calls `ctx.confirm()` itself, right before writing (so it can preview first
 * and describe exactly what will change). In read-only mode, automatic-confirm
 * writes are not registered at all, and manual ones refuse at `ctx.confirm()`.
 */
export function defineTool<S extends ZodRawShape>(
  host: ToolHost,
  name: string,
  config: {
    title: string;
    description: string;
    input: S;
    annotations: ToolAnnotations;
    confirm?: 'auto' | 'manual';
  },
  handler: (args: ToolArgs<S>, ctx: ToolContext) => Promise<ToolOutput>,
): void {
  const { guard } = host;
  const isWrite = config.annotations.readOnlyHint !== true;
  const mode = isWrite ? (config.confirm ?? 'auto') : undefined;
  if (mode === 'auto' && guard.settings.readOnly) return;

  const gated = isWrite && guard.settings.confirmWrites && !guard.settings.readOnly;
  const inputSchema = {
    ...config.input,
    ...(gated ? { confirmation_token: confirmationToken } : {}),
    response_format: responseFormat,
  };
  const description = gated
    ? `${config.description} Changes WHMCS data: the user is asked to confirm they have a backup before it runs.`
    : config.description;

  host.server.registerTool(
    name,
    { title: config.title, description, inputSchema, annotations: { title: config.title, ...config.annotations } },
    (async (rawArgs: Record<string, unknown>): Promise<CallToolResult> => {
      const { response_format: format = 'markdown', confirmation_token: _token, ...args } = rawArgs;
      let confirmedBy: string | undefined;
      const ctx: ToolContext = {
        confirm: async (summary) => {
          confirmedBy = await guard.confirm(name, rawArgs, summary);
        },
      };

      try {
        if (mode === 'auto') {
          await ctx.confirm(`${config.title} with ${JSON.stringify(args)}`);
        }
        const raw = await handler(args as ToolArgs<S>, ctx);
        const output = { ...raw, data: hideSecrets(raw.data) };
        if (confirmedBy) guard.audit({ tool: name, args: rawArgs, confirmed_by: confirmedBy, ok: true });
        const text =
          format === 'json'
            ? JSON.stringify(withoutPresentation(output), null, 2)
            : renderMarkdown(config.title, output);
        return {
          content: [{ type: 'text', text }],
          structuredContent: withoutPresentation(output) as Record<string, unknown>,
        };
      } catch (error) {
        if (error instanceof ConfirmationRequired) {
          return {
            content: [{ type: 'text', text: error.message }],
            structuredContent: { status: 'confirmation_required', ...(error.token ? { confirmation_token: error.token } : {}) },
          };
        }
        const message = error instanceof Error ? error.message : String(error);
        if (confirmedBy) guard.audit({ tool: name, args: rawArgs, confirmed_by: confirmedBy, ok: false, error: message });
        return { content: [{ type: 'text', text: `Error: ${message}` }], isError: true };
      }
    }) as any,
  );
}

/** Pagination metadata from a WHMCS list response. */
export function paginate(result: Record<string, unknown>, count: number, requestedOffset = 0): Pagination {
  const offset = Number(result.startnumber ?? requestedOffset) || 0;
  const total = Number(result.totalresults ?? count) || count;
  const hasMore = total > offset + count;
  return { total, count, offset, has_more: hasMore, ...(hasMore ? { next_offset: offset + count } : {}) };
}

function withoutPresentation({ data, pagination }: ToolOutput) {
  return pagination ? { data, pagination } : { data };
}

function cell(value: unknown): string {
  if (value === undefined || value === null) return '';
  return String(value).replace(/\|/g, '\\|').replace(/\s*\n\s*/g, ' ').trim();
}

export function renderMarkdown(title: string, output: ToolOutput): string {
  const lines: string[] = [`# ${title}`];
  const { pagination, summary = [], tables = [] } = output;

  if (pagination) {
    lines.push('', `Found ${pagination.count} of ${pagination.total} (offset ${pagination.offset}).`);
    if (pagination.next_offset !== undefined) {
      lines.push(`Next offset: ${pagination.next_offset}`);
    }
  }
  if (summary.length) {
    lines.push('', ...summary);
  }

  const rendered = tables.filter((table) => table.rows.length);
  for (const table of rendered) {
    lines.push('');
    if (table.title) lines.push(`## ${table.title}`, '');
    lines.push(`| ${table.headers.join(' | ')} |`);
    lines.push(`| ${table.headers.map(() => '---').join(' | ')} |`);
    for (const row of table.rows) {
      lines.push(`| ${row.map(cell).join(' | ')} |`);
    }
  }

  // The table is the readable view; repeating the payload as JSON below it can
  // triple the response for no gain. Callers that need every field have
  // `structuredContent`, or can ask for response_format: "json". Tools with no
  // table of their own (or an empty one) still fall back to the JSON dump.
  if (rendered.length) {
    lines.push('', '_Every field is in `structuredContent`; call again with `response_format: "json"` to see them inline._');
  } else if (!tables.length || !summary.length) {
    lines.push('', '```json', JSON.stringify(withoutPresentation(output), null, 2), '```');
  }

  return lines.join('\n');
}
