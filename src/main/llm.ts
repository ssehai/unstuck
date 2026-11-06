/**
 * LLM backends, swappable:
 *
 *  - "cli" (default): runs the local `claude` CLI in print mode, so it uses
 *    the user's own Claude subscription. Input/output are stream-json, which
 *    lets us send images and stream the answer token by token.
 *  - "api": calls the Anthropic Messages API with ANTHROPIC_API_KEY.
 *
 * Pick with UNSTUCK_BACKEND=cli|api. Model with UNSTUCK_MODEL.
 * Both keep a conversation per session id, so follow-up questions (M3) can
 * continue the same thread.
 */
import { app, ipcMain, type WebContents } from 'electron'
import { spawn, type ChildProcess } from 'child_process'
import { existsSync, mkdirSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import { randomUUID } from 'crypto'

export interface ExplainRequest {
  id: string
  system: string
  text: string
  /** PNG as base64 (no data: prefix). */
  image?: string
  /** Continue an earlier conversation. */
  sessionId?: string
  /** Model override (CLI alias like 'haiku', or a full model id). */
  model?: string
  /** One-off request: no session is kept. */
  ephemeral?: boolean
}

export type LlmEvent =
  | { id: string; kind: 'delta'; text: string }
  | { id: string; kind: 'done'; sessionId: string; text: string }
  | { id: string; kind: 'error'; message: string; auth?: boolean }

type Emit = (e: LlmEvent) => void

interface Backend {
  run(req: ExplainRequest, emit: Emit): { cancel(): void }
}

type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; source: { type: 'base64'; media_type: 'image/png'; data: string } }

function userContent(req: ExplainRequest): ContentBlock[] {
  const content: ContentBlock[] = []
  if (req.image) content.push({ type: 'image', source: { type: 'base64', media_type: 'image/png', data: req.image } })
  content.push({ type: 'text', text: req.text })
  return content
}

const AUTH_HINT = /authenticat|log ?in|oauth|api key|unauthorized|401/i

// --- Claude CLI ----------------------------------------------------------------

function findClaude(): string {
  const candidates = [
    process.env['UNSTUCK_CLAUDE_BIN'],
    join(homedir(), '.local/bin/claude'),
    join(homedir(), '.claude/local/claude'),
    '/opt/homebrew/bin/claude',
    '/usr/local/bin/claude'
  ]
  return candidates.find((p): p is string => !!p && existsSync(p)) ?? 'claude'
}

class ClaudeCliBackend implements Backend {
  private readonly bin = findClaude()
  private readonly model = process.env['UNSTUCK_MODEL'] || 'sonnet'

  run(req: ExplainRequest, emit: Emit): { cancel(): void } {
    // A dedicated, empty working directory: no project CLAUDE.md, and the
    // CLI's saved sessions for this app stay in one place.
    const cwd = join(app.getPath('userData'), 'claude-sessions')
    mkdirSync(cwd, { recursive: true })

    const args = [
      '-p',
      '--input-format', 'stream-json',
      '--output-format', 'stream-json',
      '--verbose',
      '--include-partial-messages',
      '--model', req.model || this.model,
      '--tools', '', // pure reasoning: no file or shell access
      '--setting-sources', '', // ignore the user's hooks/plugins/output styles
      '--strict-mcp-config', // and their MCP servers
      '--system-prompt', req.system
    ]
    if (req.sessionId) args.push('--resume', req.sessionId)
    if (req.ephemeral) args.push('--no-session-persistence')

    let child: ChildProcess
    try {
      child = spawn(this.bin, args, { cwd, env: process.env, stdio: ['pipe', 'pipe', 'pipe'] })
    } catch (err) {
      emit({ id: req.id, kind: 'error', message: `Could not start the Claude CLI: ${(err as Error).message}` })
      return { cancel: () => undefined }
    }

    let full = ''
    let finished = false
    let stderr = ''
    let buffer = ''
    const finish = (e: LlmEvent): void => {
      if (finished) return
      finished = true
      emit(e)
    }

    child.stdout!.setEncoding('utf8')
    child.stdout!.on('data', (chunk: string) => {
      buffer += chunk
      let nl: number
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, nl).trim()
        buffer = buffer.slice(nl + 1)
        if (!line) continue
        let msg: Record<string, any>
        try {
          msg = JSON.parse(line)
        } catch {
          continue
        }
        if (msg.type === 'stream_event') {
          const ev = msg.event
          if (ev?.type === 'content_block_delta' && ev.delta?.type === 'text_delta') {
            full += ev.delta.text
            emit({ id: req.id, kind: 'delta', text: ev.delta.text })
          }
        } else if (msg.type === 'result') {
          if (msg.is_error || msg.subtype !== 'success') {
            const message = String(msg.result || msg.error || 'The Claude CLI reported an error.')
            finish({ id: req.id, kind: 'error', message, auth: AUTH_HINT.test(message) })
          } else {
            finish({ id: req.id, kind: 'done', sessionId: msg.session_id, text: full || String(msg.result ?? '') })
          }
        }
      }
    })
    child.stderr!.setEncoding('utf8')
    child.stderr!.on('data', (d: string) => (stderr += d))
    child.on('error', (err) => {
      const notFound = (err as NodeJS.ErrnoException).code === 'ENOENT'
      finish({
        id: req.id,
        kind: 'error',
        message: notFound
          ? 'The `claude` command was not found. Install Claude Code, or set UNSTUCK_CLAUDE_BIN to its path.'
          : err.message
      })
    })
    child.on('close', (code) => {
      if (!finished) {
        const message = stderr.trim() || `The Claude CLI exited with code ${code}.`
        finish({ id: req.id, kind: 'error', message, auth: AUTH_HINT.test(message) })
      }
    })

    child.stdin!.write(JSON.stringify({ type: 'user', message: { role: 'user', content: userContent(req) } }) + '\n')
    child.stdin!.end()

    return {
      cancel: () => {
        finished = true
        child.kill()
      }
    }
  }
}

// --- Anthropic API -----------------------------------------------------------------

/** CLI-style aliases → API model ids. */
const API_MODELS: Record<string, string> = {
  haiku: 'claude-haiku-5-5',
  sonnet: 'claude-sonnet-5-5',
  opus: 'claude-opus-5-5'
}

class AnthropicApiBackend implements Backend {
  private readonly model = process.env['UNSTUCK_MODEL'] || 'claude-sonnet-5-5'
  private readonly history = new Map<string, { role: 'user' | 'assistant'; content: ContentBlock[] | string }[]>()

  run(req: ExplainRequest, emit: Emit): { cancel(): void } {
    const key = process.env['ANTHROPIC_API_KEY']
    const controller = new AbortController()
    if (!key) {
      emit({ id: req.id, kind: 'error', message: 'ANTHROPIC_API_KEY is not set.', auth: true })
      return { cancel: () => undefined }
    }
    const sessionId = req.sessionId ?? randomUUID()
    const messages = [...(this.history.get(sessionId) ?? []), { role: 'user' as const, content: userContent(req) }]

    ;(async () => {
      let full = ''
      try {
        const res = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          signal: controller.signal,
          headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
          body: JSON.stringify({
            model: req.model ? API_MODELS[req.model] ?? req.model : this.model,
            max_tokens: 2048,
            stream: true,
            // The paper is in the system prompt and reused across questions.
            system: [{ type: 'text', text: req.system, cache_control: { type: 'ephemeral' } }],
            messages
          })
        })
        if (!res.ok || !res.body) {
          const body = await res.text()
          emit({ id: req.id, kind: 'error', message: `API error ${res.status}: ${body.slice(0, 300)}`, auth: res.status === 401 })
          return
        }
        const reader = res.body.getReader()
        const decoder = new TextDecoder()
        let buf = ''
        for (;;) {
          const { done, value } = await reader.read()
          if (done) break
          buf += decoder.decode(value, { stream: true })
          let nl: number
          while ((nl = buf.indexOf('\n')) >= 0) {
            const line = buf.slice(0, nl).trim()
            buf = buf.slice(nl + 1)
            if (!line.startsWith('data:')) continue
            try {
              const ev = JSON.parse(line.slice(5))
              if (ev.type === 'content_block_delta' && ev.delta?.type === 'text_delta') {
                full += ev.delta.text
                emit({ id: req.id, kind: 'delta', text: ev.delta.text })
              }
            } catch {
              /* ignore keep-alives */
            }
          }
        }
        if (!req.ephemeral) this.history.set(sessionId, [...messages, { role: 'assistant', content: full }])
        emit({ id: req.id, kind: 'done', sessionId, text: full })
      } catch (err) {
        if (!controller.signal.aborted) emit({ id: req.id, kind: 'error', message: (err as Error).message })
      }
    })()
    return { cancel: () => controller.abort() }
  }
}

// --- IPC ---------------------------------------------------------------------------

export function registerLlm(): void {
  const backend: Backend = process.env['UNSTUCK_BACKEND'] === 'api' ? new AnthropicApiBackend() : new ClaudeCliBackend()
  const running = new Map<string, { cancel(): void }>()

  ipcMain.handle('llm:explain', (e, req: ExplainRequest) => {
    if (!req || typeof req.id !== 'string' || typeof req.text !== 'string' || typeof req.system !== 'string') {
      throw new Error('Bad request')
    }
    const sender: WebContents = e.sender
    const emit: Emit = (ev) => {
      if (ev.kind !== 'delta') running.delete(ev.id)
      if (!sender.isDestroyed()) sender.send('llm:event', ev)
    }
    running.set(req.id, backend.run(req, emit))
    return true
  })

  ipcMain.handle('llm:cancel', (_e, id: unknown) => {
    if (typeof id !== 'string') return false
    running.get(id)?.cancel()
    running.delete(id)
    return true
  })
}
