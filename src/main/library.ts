/**
 * Paper library: PDFs the user has opened are copied into the app's data
 * folder (e.g. ~/Library/Application Support/unstuck/library on macOS), so
 * they can be reopened without uploading them again.
 *
 *   library/index.json     metadata for every paper
 *   library/<id>.pdf       the file itself; id = first 16 hex chars of SHA-256
 */
import { app, ipcMain } from 'electron'
import { createHash } from 'crypto'
import { promises as fs } from 'fs'
import { basename, join } from 'path'

export interface PaperView {
  page: number
  scale: string // pdf.js currentScaleValue: 'page-width' or a number as text
}

export interface PaperMeta {
  id: string
  name: string
  size: number
  addedAt: number
  lastOpenedAt: number
  view?: PaperView
}

const ID = /^[0-9a-f]{16}$/

const dir = (): string => join(app.getPath('userData'), 'library')
const indexPath = (): string => join(dir(), 'index.json')
const pdfPath = (id: string): string => {
  if (!ID.test(id)) throw new Error('Invalid paper id')
  return join(dir(), `${id}.pdf`)
}

async function load(): Promise<PaperMeta[]> {
  try {
    const parsed = JSON.parse(await fs.readFile(indexPath(), 'utf8'))
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

// Writes are queued so concurrent requests never interleave on index.json.
let queue: Promise<unknown> = Promise.resolve()
function mutate<T>(fn: (list: PaperMeta[]) => Promise<T> | T): Promise<T> {
  const run = queue.then(async () => {
    const list = await load()
    const result = await fn(list)
    await fs.mkdir(dir(), { recursive: true })
    const tmp = `${indexPath()}.tmp`
    await fs.writeFile(tmp, JSON.stringify(list, null, 2))
    await fs.rename(tmp, indexPath())
    return result
  })
  queue = run.catch(() => undefined)
  return run
}

const byRecent = (list: PaperMeta[]): PaperMeta[] => [...list].sort((a, b) => b.lastOpenedAt - a.lastOpenedAt)

export function registerLibrary(): void {
  ipcMain.handle('library:list', async () => byRecent(await load()))

  ipcMain.handle('library:add', (_e, name: unknown, data: unknown) => {
    if (typeof name !== 'string' || !(data instanceof Uint8Array)) throw new Error('Bad arguments')
    const id = createHash('sha256').update(data).digest('hex').slice(0, 16)
    const cleanName = basename(name).slice(0, 200) || 'paper.pdf'
    return mutate(async (list) => {
      const now = Date.now()
      const existing = list.find((p) => p.id === id)
      if (existing) {
        existing.lastOpenedAt = now
        return existing
      }
      await fs.mkdir(dir(), { recursive: true })
      await fs.writeFile(pdfPath(id), data)
      const meta: PaperMeta = { id, name: cleanName, size: data.byteLength, addedAt: now, lastOpenedAt: now }
      list.push(meta)
      return meta
    })
  })

  ipcMain.handle('library:read', async (_e, id: unknown) => {
    if (typeof id !== 'string') throw new Error('Bad arguments')
    return new Uint8Array(await fs.readFile(pdfPath(id)))
  })

  ipcMain.handle('library:update', (_e, id: unknown, patch: unknown) => {
    if (typeof id !== 'string' || !ID.test(id) || typeof patch !== 'object' || !patch) throw new Error('Bad arguments')
    const p = patch as Partial<Pick<PaperMeta, 'lastOpenedAt' | 'view'>>
    return mutate((list) => {
      const meta = list.find((m) => m.id === id)
      if (!meta) return null
      if (typeof p.lastOpenedAt === 'number') meta.lastOpenedAt = p.lastOpenedAt
      if (p.view && typeof p.view.page === 'number' && typeof p.view.scale === 'string') {
        meta.view = { page: p.view.page, scale: p.view.scale }
      }
      return meta
    })
  })

  ipcMain.handle('library:remove', (_e, id: unknown) => {
    if (typeof id !== 'string' || !ID.test(id)) throw new Error('Bad arguments')
    return mutate(async (list) => {
      const i = list.findIndex((m) => m.id === id)
      if (i >= 0) list.splice(i, 1)
      await fs.rm(pdfPath(id), { force: true })
      return true
    })
  })
}
