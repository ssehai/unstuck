/**
 * Saved papers. In the Electron app, PDFs live on disk in the app's data
 * folder (handled by the main process, see src/main/library.ts). When the UI
 * runs in a plain browser (e.g. the Vite dev page) the same interface is
 * backed by IndexedDB, so the app behaves the same either way.
 */

import type { PaperFigure } from './figures'

export interface PaperView {
  page: number
  scale: string
}

export interface PaperMeta {
  id: string
  name: string
  size: number
  addedAt: number
  lastOpenedAt: number
  view?: PaperView
  /** Figures found in the paper, with the detector version (see figures.ts). */
  figures?: { v: number; items: PaperFigure[] }
}

export interface Library {
  list(): Promise<PaperMeta[]>
  add(name: string, data: Uint8Array): Promise<PaperMeta>
  read(id: string): Promise<Uint8Array>
  update(id: string, patch: { lastOpenedAt?: number; view?: PaperView; figures?: PaperMeta['figures'] }): Promise<PaperMeta | null>
  remove(id: string): Promise<boolean>
}

export function getLibrary(): Library {
  return window.unstuckApi?.library ?? indexedDbLibrary()
}

// --- Browser fallback ----------------------------------------------------------

function indexedDbLibrary(): Library {
  const dbp = new Promise<IDBDatabase>((resolve, reject) => {
    const req = indexedDB.open('unstuck-library', 1)
    req.onupgradeneeded = () => {
      req.result.createObjectStore('meta', { keyPath: 'id' })
      req.result.createObjectStore('files')
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })

  const run = async <T>(stores: string[], mode: IDBTransactionMode, fn: (t: IDBTransaction) => IDBRequest<T> | void): Promise<T> => {
    const db = await dbp
    return new Promise<T>((resolve, reject) => {
      const t = db.transaction(stores, mode)
      const req = fn(t)
      t.oncomplete = () => resolve(req ? req.result : (undefined as T))
      t.onerror = () => reject(t.error)
    })
  }
  const getMeta = (id: string): Promise<PaperMeta | undefined> =>
    run(['meta'], 'readonly', (t) => t.objectStore('meta').get(id))

  return {
    async list() {
      const all = await run<PaperMeta[]>(['meta'], 'readonly', (t) => t.objectStore('meta').getAll())
      return all.sort((a, b) => b.lastOpenedAt - a.lastOpenedAt)
    },
    async add(name, data) {
      const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', data))
      const id = Array.from(digest.slice(0, 8), (b) => b.toString(16).padStart(2, '0')).join('')
      const now = Date.now()
      const meta: PaperMeta = { ...((await getMeta(id)) ?? { id, name, size: data.byteLength, addedAt: now }), lastOpenedAt: now }
      await run(['meta', 'files'], 'readwrite', (t) => {
        t.objectStore('meta').put(meta)
        t.objectStore('files').put(data, id)
      })
      return meta
    },
    async read(id) {
      const data = await run<Uint8Array | undefined>(['files'], 'readonly', (t) => t.objectStore('files').get(id))
      if (!data) throw new Error('Paper not found')
      return data
    },
    async update(id, patch) {
      const meta = await getMeta(id)
      if (!meta) return null
      Object.assign(meta, patch)
      await run(['meta'], 'readwrite', (t) => {
        t.objectStore('meta').put(meta)
      })
      return meta
    },
    async remove(id) {
      await run(['meta', 'files'], 'readwrite', (t) => {
        t.objectStore('meta').delete(id)
        t.objectStore('files').delete(id)
      })
      return true
    }
  }
}
