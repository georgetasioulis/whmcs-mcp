/**
 * Guard rails for tools that change the WHMCS installation.
 *
 * Every write is confirmed before it runs, in the strongest way the MCP client
 * supports:
 *
 * 1. Elicitation: the server asks the *user* directly through the client UI.
 *    The model never sees or answers the question, so it cannot skip it.
 * 2. Otherwise, a two-step token: the first call changes nothing and returns a
 *    single-use token bound to the exact arguments; only a repeat of the same
 *    call with that token runs. This relies on the model stopping to ask.
 *
 * Every write is also appended to a local JSONL audit log.
 */
import { createHash, randomBytes } from 'node:crypto';
import { appendFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

export type SafetySettings = {
  readOnly: boolean;
  confirmWrites: boolean;
  /** Path of the audit log, or null when it is off. */
  auditLog: string | null;
};

export const DEFAULT_AUDIT_LOG = join(homedir(), '.whmcs-mcp', 'audit.jsonl');

export function safetySettings(config: { readOnly?: boolean; confirmWrites?: boolean; auditLog?: string | false }): SafetySettings {
  return {
    readOnly: config.readOnly ?? false,
    confirmWrites: config.confirmWrites ?? true,
    auditLog: config.auditLog === false ? null : (config.auditLog ?? DEFAULT_AUDIT_LOG),
  };
}

/** Thrown by a write that has not been confirmed yet; reported to the caller, not as a failure. */
export class ConfirmationRequired extends Error {
  constructor(
    message: string,
    readonly token?: string,
  ) {
    super(message);
  }
}

const TOKEN_TTL_MS = 10 * 60_000;
const SECRET_ARGS = new Set(['servicepassword', 'password']);
// Fields WHMCS returns that hold credentials: GetClientsProducts includes each
// service's account password in clear text.
const SECRET_FIELDS = new Set(['password', 'servicepassword', 'securityqans']);

export const BACKUP_WARNING =
  'This is going to change data in your WHMCS installation. Please confirm you have a current backup before continuing.';

export class WriteGuard {
  private readonly tokens = new Map<string, { fingerprint: string; expires: number }>();

  constructor(
    readonly settings: SafetySettings,
    private readonly server: McpServer,
    private readonly now: () => number = Date.now,
  ) {}

  /**
   * Resolves when the write described by `summary` may go ahead; throws
   * ConfirmationRequired (or a plain Error for a refusal) otherwise.
   */
  async confirm(tool: string, args: Record<string, unknown>, summary: string): Promise<'elicitation' | 'token' | 'disabled'> {
    if (this.settings.readOnly) {
      throw new Error('This WHMCS MCP server is in read-only mode (WHMCS_READ_ONLY); no changes can be made.');
    }
    if (!this.settings.confirmWrites) return 'disabled';

    if (this.server.server.getClientCapabilities()?.elicitation) {
      const answer = await this.server.server.elicitInput({
        message: `${BACKUP_WARNING}\n\n${summary}`,
        requestedSchema: {
          type: 'object',
          properties: {
            backup_confirmed: {
              type: 'boolean',
              title: 'I have a current backup and want to make this change',
            },
          },
          required: ['backup_confirmed'],
        },
      });
      if (answer.action === 'accept' && answer.content?.backup_confirmed === true) return 'elicitation';
      const outcome = { accept: 'not confirmed', decline: 'declined', cancel: 'cancelled' }[answer.action];
      throw new ConfirmationRequired(`Not executed: the change was ${outcome} in the confirmation prompt.`);
    }

    const fingerprint = this.fingerprint(tool, args);
    const supplied = typeof args.confirmation_token === 'string' ? args.confirmation_token : undefined;
    const known = supplied ? this.tokens.get(supplied) : undefined;
    if (supplied && known && known.fingerprint === fingerprint && known.expires > this.now()) {
      this.tokens.delete(supplied);
      return 'token';
    }

    const token = randomBytes(6).toString('hex');
    this.tokens.set(token, { fingerprint, expires: this.now() + TOKEN_TTL_MS });
    const stale = supplied ? 'The token given was unknown, expired, or issued for different arguments. ' : '';
    throw new ConfirmationRequired(
      `NOT EXECUTED — confirmation required. ${stale}${BACKUP_WARNING}\n\n${summary}\n\n` +
        'Show this to the user and ask them to confirm they have a backup. Only after they say yes, repeat the ' +
        `same call with the same arguments plus confirmation_token: "${token}" (valid 10 minutes, once).`,
      token,
    );
  }

  audit(entry: { tool: string; args: Record<string, unknown>; confirmed_by: string; ok: boolean; error?: string }): void {
    if (!this.settings.auditLog) return;
    try {
      mkdirSync(dirname(this.settings.auditLog), { recursive: true });
      appendFileSync(
        this.settings.auditLog,
        `${JSON.stringify({ time: new Date(this.now()).toISOString(), ...entry, args: redact(entry.args) })}\n`,
      );
    } catch (error) {
      // An unwritable log must not undo a write that already happened; say so on stderr.
      console.error(`Could not write the audit log ${this.settings.auditLog}:`, error);
    }
  }

  private fingerprint(tool: string, args: Record<string, unknown>): string {
    const { confirmation_token: _token, response_format: _format, ...rest } = args;
    return createHash('sha256').update(`${tool}\n${canonicalJson(rest)}`).digest('hex');
  }
}

/** JSON with object keys sorted at every depth, so equal arguments always serialize the same. */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

function redact(args: Record<string, unknown>): Record<string, unknown> {
  const { confirmation_token: _token, response_format: _format, ...rest } = args;
  return Object.fromEntries(Object.entries(rest).map(([key, value]) => [key, SECRET_ARGS.has(key) ? '[redacted]' : value]));
}

/**
 * A copy of a WHMCS response with credential fields blanked, at any depth.
 * Tool output goes into the model's context and the chat transcript, which is
 * no place for a client's hosting or licence password.
 */
export function hideSecrets<T>(value: T): T {
  if (Array.isArray(value)) return value.map(hideSecrets) as T;
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, field]) => [
      key,
      SECRET_FIELDS.has(key.toLowerCase()) && typeof field === 'string' && field !== '' ? '[hidden]' : hideSecrets(field),
    ]),
  ) as T;
}
