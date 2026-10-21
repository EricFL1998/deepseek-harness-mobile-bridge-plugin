/**
 * The transport-independent bridge handler.
 *
 * One function answers both carriers — the Host's `webServer` routes and the
 * standalone dev server — so the wire behavior has exactly one home and both
 * carriers are testable without the other.
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import { BridgeFailure, ProviderRegistry } from './protocol/provider.ts'
import {
  BRIDGE_VERSION, MANIFEST_PATH, QUERY_PATH,
  type ManifestResponse, type ProviderManifestEntry, type QueryRequest, type QueryResponse,
} from './protocol/types.ts'
import { projectJson } from './protocol/json.ts'

/** Ceiling on one `/query` request body. */
const MAX_REQUEST_BYTES = 256 * 1024

/** What the handler needs to answer. */
export interface BridgeHandlerOptions {
  /** The provider table. */
  readonly registry: ProviderRegistry
  /** The bridge plugin package's own version. */
  readonly pluginVersion: () => string
  /** The Host release label, or null when the Host publishes none. */
  readonly dshVersion: () => string | null
  /** Notes collected at assembly time, reported on every manifest. */
  readonly assemblyWarnings: readonly string[]
  /**
   * Decide whether a request may proceed.
   * @param request - the raw Node request.
   * @returns the HTTP status to refuse with, or undefined to admit.
   */
  readonly admit?: (request: IncomingMessage) => number | undefined
}

/** One response the handler decided on. */
export interface BridgeReply {
  readonly status: number
  readonly body: unknown
  /** Extra response headers beyond `content-type`. */
  readonly headers?: Readonly<Record<string, string>>
}

/**
 * Build the request handler.
 * @param options - registry, version facts, and admission policy.
 * @returns the handler both carriers call.
 */
export function createBridgeHandler(options: BridgeHandlerOptions): (request: IncomingMessage) => Promise<BridgeReply> {
  // Provider list, versions and warnings are fixed at assembly time; build the
  // manifest once instead of re-projecting it on every poll.
  let manifestCache: ManifestResponse | undefined
  const manifest = (): ManifestResponse => {
    if (manifestCache !== undefined) return manifestCache
    const providers: ProviderManifestEntry[] = options.registry.list().map(provider => ({
      id: provider.id,
      version: provider.version,
      capabilities: Object.keys(provider.ops),
      ...(provider.readOnly === true ? { readOnly: true as const } : {}),
      ...(provider.authorization === undefined ? {} : { authorization: provider.authorization }),
    }))
    manifestCache = {
      bridgeVersion: BRIDGE_VERSION,
      pluginVersion: options.pluginVersion(),
      dshVersion: options.dshVersion(),
      providers,
      ...(options.assemblyWarnings.length === 0 ? {} : { warnings: [...options.assemblyWarnings] }),
    }
    return manifestCache
  }

  return async (request: IncomingMessage): Promise<BridgeReply> => {
    const rejection = options.admit?.(request)
    if (rejection !== undefined) {
      return { status: rejection, body: { ok: false, error: { code: 'auth/required', message: 'the Host refused this caller' } } }
    }
    // Node always sets `url` on a server request; String keeps that fact local.
    const url = new URL(String(request.url), 'http://127.0.0.1')
    if (url.pathname === MANIFEST_PATH) {
      if (request.method !== 'GET') return methodNotAllowed('GET')
      return { status: 200, body: manifest(), headers: { 'cache-control': 'no-store' } }
    }
    if (url.pathname === QUERY_PATH) {
      if (request.method !== 'POST') return methodNotAllowed('POST')
      return { status: 200, body: await answerQuery(request, options.registry), headers: { 'cache-control': 'no-store' } }
    }
    return {
      status: 404,
      body: { ok: false, error: { code: 'request/malformed', message: `no bridge route at ${url.pathname}` } },
    }
  }
}

/** 405 reply naming the route's one method. */
function methodNotAllowed(allow: 'GET' | 'POST'): BridgeReply {
  return {
    status: 405,
    headers: { allow },
    body: { ok: false, error: { code: 'request/unsupported-method', message: `use ${allow}` } },
  }
}

/**
 * Read, validate, and answer one `/query` body.
 * @param request - the raw Node request.
 * @param registry - the provider table.
 * @returns the response body; failures are `ok: false`, never partial.
 */
async function answerQuery(request: IncomingMessage, registry: ProviderRegistry): Promise<QueryResponse> {
  const essence = String(request.headers['content-type']).split(';', 1)[0]?.trim().toLowerCase()
  if (essence !== 'application/json') {
    return {
      ok: false,
      error: { code: 'request/malformed', message: 'content-type must be application/json' },
    }
  }
  let text: string
  try {
    text = await readBounded(request)
  } catch (error) {
    return { ok: false, error: { code: 'request/malformed', message: (error as Error).message } }
  }
  let body: unknown
  try {
    body = JSON.parse(text)
  } catch {
    return { ok: false, error: { code: 'request/malformed', message: 'request body is not JSON' } }
  }
  const parsed = parseQuery(body)
  if ('error' in parsed) return { ok: false, error: parsed.error }
  try {
    const answer = await registry.query(parsed.request.provider, parsed.request.op, parsed.request.args ?? {})
    const projected = projectJson(answer.data, 'data')
    return {
      ok: true,
      provider: answer.provider,
      version: answer.version,
      data: projected.value ?? null,
      warnings: [
        ...answer.warnings,
        ...projected.dropped.map(path => `dropped ${path}`),
        ...projected.coerced.map(path => `coerced ${path} to text`),
      ],
    }
  } catch (error) {
    if (error instanceof BridgeFailure) {
      return {
        ok: false,
        error: {
          code: error.code,
          message: error.message,
          ...(error.details === undefined ? {} : { details: error.details }),
        },
      }
    }
    return { ok: false, error: { code: 'internal/error', message: (error as Error).message } }
  }
}

/** Parsed request or the failure to answer with. */
type ParsedQuery =
  | { readonly request: QueryRequest }
  | { readonly error: { readonly code: 'request/malformed'; readonly message: string } }

/**
 * Validate one decoded `/query` body at the wire.
 * @param body - the decoded JSON value.
 * @returns the request, or the failure to answer with.
 */
function parseQuery(body: unknown): ParsedQuery {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return { error: { code: 'request/malformed', message: 'request body must be a JSON object' } }
  }
  const record = body as Record<string, unknown>
  const provider = record.provider
  const op = record.op
  if (typeof provider !== 'string' || provider === '') {
    return { error: { code: 'request/malformed', message: 'provider must be a non-empty string' } }
  }
  if (typeof op !== 'string' || op === '') {
    return { error: { code: 'request/malformed', message: 'op must be a non-empty string' } }
  }
  const args = record.args
  if (args !== undefined && (typeof args !== 'object' || args === null || Array.isArray(args))) {
    return { error: { code: 'request/malformed', message: 'args must be an object when present' } }
  }
  return {
    request: {
      provider,
      op,
      ...(args === undefined ? {} : { args: args as Readonly<Record<string, unknown>> }),
    },
  }
}

/**
 * Read a request body up to the ceiling.
 * @param request - the raw Node request.
 * @returns the UTF-8 body text.
 * @throws {Error} when the body exceeds the ceiling; the stream is drained first.
 */
async function readBounded(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of request as AsyncIterable<Buffer>) {
    size += chunk.byteLength
    if (size > MAX_REQUEST_BYTES) {
      // Drain the remainder so the refusal is a readable response, not a socket cut.
      request.resume()
      throw new Error(`request body exceeds ${MAX_REQUEST_BYTES} bytes`)
    }
    chunks.push(chunk)
  }
  return Buffer.concat(chunks, size).toString('utf8')
}

/**
 * Write one handler reply onto a Node response.
 * @param response - the Node response to own.
 * @param reply - the decided status, body, and headers.
 */
export function writeReply(response: ServerResponse, reply: BridgeReply): void {
  response.statusCode = reply.status
  for (const [name, value] of Object.entries(reply.headers ?? {})) response.setHeader(name, value)
  response.setHeader('content-type', 'application/json; charset=utf-8')
  response.end(JSON.stringify(reply.body))
}
