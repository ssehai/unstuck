/**
 * User settings from the Preferences window: which LLM backend, which model,
 * and the Anthropic API key.
 *
 *   <userData>/settings.json   { backend, model, apiKey (encrypted) }
 *
 * The key is encrypted with Electron's safeStorage (backed by the macOS
 * Keychain) and never stored in plain text. Environment variables still win,
 * so `UNSTUCK_BACKEND=api npm run dev` keeps working during development; a
 * packaged app opened from the Dock does not see the shell's variables, which
 * is why these settings exist.
 */
import { app, ipcMain, safeStorage } from 'electron'
import { mkdirSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'

export type BackendName = 'cli' | 'api'
export const MODELS = ['sonnet', 'opus', 'haiku'] as const
export type ModelAlias = (typeof MODELS)[number]

interface Stored {
  backend?: BackendName
  model?: ModelAlias
  /** base64 of safeStorage.encryptString(key) */
  apiKey?: string
}

/** What the Preferences window shows. The key itself never leaves the main process. */
export interface SettingsView {
  backend: BackendName
  model: ModelAlias
  hasApiKey: boolean
  /** Environment variables that currently override a setting. */
  envOverrides: string[]
  canEncrypt: boolean
}

export interface SettingsPatch {
  backend?: BackendName
  model?: ModelAlias
  /** A new key, or null to delete the saved one. */
  apiKey?: string | null
}

const file = (): string => join(app.getPath('userData'), 'settings.json')

function readStored(): Stored {
  try {
    return JSON.parse(readFileSync(file(), 'utf8')) as Stored
  } catch {
    return {}
  }
}

function writeStored(s: Stored): void {
  mkdirSync(app.getPath('userData'), { recursive: true })
  writeFileSync(file(), JSON.stringify(s, null, 2), { mode: 0o600 })
}

const env = (name: string): string | undefined => process.env[name] || undefined

export function backendName(): BackendName {
  const fromEnv = env('UNSTUCK_BACKEND')
  if (fromEnv) return fromEnv === 'api' ? 'api' : 'cli'
  return readStored().backend === 'api' ? 'api' : 'cli'
}

/** Default model: a CLI alias (or, from UNSTUCK_MODEL, any model id). */
export function modelName(): string {
  const stored = readStored().model
  return env('UNSTUCK_MODEL') ?? (stored && MODELS.includes(stored) ? stored : 'sonnet')
}

export function apiKey(): string | undefined {
  const fromEnv = env('ANTHROPIC_API_KEY')
  if (fromEnv) return fromEnv
  const enc = readStored().apiKey
  if (!enc || !safeStorage.isEncryptionAvailable()) return undefined
  try {
    return safeStorage.decryptString(Buffer.from(enc, 'base64'))
  } catch {
    return undefined // e.g. encrypted by another build whose Keychain access was denied
  }
}

function view(): SettingsView {
  const s = readStored()
  return {
    backend: s.backend === 'api' ? 'api' : 'cli',
    model: s.model && MODELS.includes(s.model) ? s.model : 'sonnet',
    hasApiKey: !!s.apiKey,
    envOverrides: ['UNSTUCK_BACKEND', 'UNSTUCK_MODEL', 'ANTHROPIC_API_KEY'].filter((n) => env(n)),
    canEncrypt: safeStorage.isEncryptionAvailable()
  }
}

export function registerSettings(): void {
  ipcMain.handle('settings:get', () => view())

  ipcMain.handle('settings:set', (_e, patch: SettingsPatch) => {
    const s = readStored()
    if (patch?.backend === 'cli' || patch?.backend === 'api') s.backend = patch.backend
    if (patch?.model && MODELS.includes(patch.model)) s.model = patch.model
    if (patch?.apiKey === null) delete s.apiKey
    else if (typeof patch?.apiKey === 'string' && patch.apiKey.trim()) {
      if (!safeStorage.isEncryptionAvailable()) throw new Error('Encryption is not available on this system.')
      s.apiKey = safeStorage.encryptString(patch.apiKey.trim()).toString('base64')
    }
    writeStored(s)
    return view()
  })
}
