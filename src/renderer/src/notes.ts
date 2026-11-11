import type { PaperFigure } from './figures'
/**
 * Stuck points: every passage the reader asked about, with the conversation
 * and, once they press "Got it", a condensed note. Stored per paper (on disk
 * via the main process; in localStorage when running in a plain browser).
 */

export interface StoredTurn {
  role: 'user' | 'assistant'
  /** What is shown in the thread (e.g. "선행 개념" for a quick button). */
  display: string
  /** What was actually sent / received. */
  text: string
}

/** One place in the paper a stuck point refers to. */
export interface Anchor {
  page: number
  pageEnd: number
  quote: string
  figure?: PaperFigure
}

/** The places a stuck point refers to (one, unless several were asked about together). */
export function anchorsOf(r: StuckRecord): Anchor[] {
  return r.parts?.length ? r.parts : [{ page: r.page, pageEnd: r.pageEnd, quote: r.quote, figure: r.figure }]
}

export interface StuckRecord {
  id: string
  paperId: string
  createdAt: number
  updatedAt: number
  page: number
  pageEnd: number
  /** The selected passage; also used to find it again in the page. */
  quote: string
  /** Image sent with the first question (data URL), if any. Older records; see `images`. */
  image?: string
  /** Images sent with the first question (data URLs): figures and equations. */
  images?: string[]
  /** Set when the stuck point is a whole figure (`quote` is then its caption). */
  figure?: PaperFigure
  /**
   * Several places asked about together (⌘-selection). The first is the one
   * in page / pageEnd / quote / figure above.
   */
  parts?: Anchor[]
  sessionId?: string
  turns: StoredTurn[]
  status: 'open' | 'understood'
  /** Markdown note written when the reader pressed "Got it". */
  note?: string
}

export interface NotesStore {
  list(paperId: string): Promise<StuckRecord[]>
  put(paperId: string, record: StuckRecord): Promise<boolean>
  remove(paperId: string, id: string): Promise<boolean>
}

export function getNotesStore(): NotesStore {
  return (window.unstuckApi?.notes as NotesStore | undefined) ?? localStore
}

const key = (paperId: string): string => `unstuck.notes.${paperId}`
const read = (paperId: string): StuckRecord[] => {
  try {
    return JSON.parse(localStorage.getItem(key(paperId)) ?? '[]')
  } catch {
    return []
  }
}
const localStore: NotesStore = {
  async list(paperId) {
    return read(paperId)
  },
  async put(paperId, record) {
    const list = read(paperId).filter((r) => r.id !== record.id)
    list.push(record)
    try {
      localStorage.setItem(key(paperId), JSON.stringify(list))
    } catch {
      return false
    }
    return true
  },
  async remove(paperId, id) {
    try {
      localStorage.setItem(key(paperId), JSON.stringify(read(paperId).filter((r) => r.id !== id)))
    } catch {
      return false
    }
    return true
  }
}
