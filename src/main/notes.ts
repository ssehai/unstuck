/**
 * Stuck points and "Got it" notes, stored per paper next to the library:
 *
 *   library/notes/<paperId>.json   array of stuck-point records
 *
 * The main process treats records as opaque JSON (validated for shape and
 * size); the renderer owns their structure (see src/renderer/src/notes.ts).
 */
import { app, ipcMain } from 'electron'
import { promises as fs } from 'fs'
import { join } from 'path'

const PAPER_ID = /^[0-9a-f]{16}$/
const RECORD_ID = /^[0-9a-f-]{8,64}$/
const MAX_RECORD_BYTES = 512 * 1024

type Rec = { id: string } & Record<string, unknown>

const dir = (): string => join(app.getPath('userData'), 'library', 'notes')
const file = (paperId: string): string => {
  if (!PAPER_ID.test(paperId)) throw new Error('Invalid paper id')
  return join(dir(), `${paperId}.json`)
}

async function load(paperId: string): Promise<Rec[]> {
  try {
    const parsed = JSON.parse(await fs.readFile(file(paperId), 'utf8'))
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

// One write queue for all papers keeps read-modify-write cycles atomic.
let queue: Promise<unknown> = Promise.resolve()
function mutate<T>(paperId: string, fn: (list: Rec[]) => T): Promise<T> {
  const run = queue.then(async () => {
    const list = await load(paperId)
    const result = fn(list)
    await fs.mkdir(dir(), { recursive: true })
    const tmp = `${file(paperId)}.tmp`
    await fs.writeFile(tmp, JSON.stringify(list, null, 2))
    await fs.rename(tmp, file(paperId))
    return result
  })
  queue = run.catch(() => undefined)
  return run
}

export function registerNotes(): void {
  ipcMain.handle('notes:list', (_e, paperId: unknown) => {
    if (typeof paperId !== 'string') throw new Error('Bad arguments')
    return load(paperId)
  })

  ipcMain.handle('notes:put', (_e, paperId: unknown, record: unknown) => {
    if (typeof paperId !== 'string' || typeof record !== 'object' || !record) throw new Error('Bad arguments')
    const rec = record as Rec
    if (typeof rec.id !== 'string' || !RECORD_ID.test(rec.id)) throw new Error('Bad record id')
    if (JSON.stringify(rec).length > MAX_RECORD_BYTES) throw new Error('Record too large')
    return mutate(paperId, (list) => {
      const i = list.findIndex((r) => r.id === rec.id)
      if (i >= 0) list[i] = rec
      else list.push(rec)
      return true
    })
  })

  ipcMain.handle('notes:remove', (_e, paperId: unknown, id: unknown) => {
    if (typeof paperId !== 'string' || typeof id !== 'string') throw new Error('Bad arguments')
    return mutate(paperId, (list) => {
      const i = list.findIndex((r) => r.id === id)
      if (i >= 0) list.splice(i, 1)
      return true
    })
  })
}
