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

export interface StuckRecord {
  id: string
  paperId: string
  createdAt: number
  updatedAt: number
  page: number
  pageEnd: number
  /** The selected passage; also used to find it again in the page. */
  quote: string
  /** Equation image sent with the first question (data URL), if any. */
  image?: string
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
