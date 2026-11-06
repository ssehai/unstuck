/**
 * Evaluation results (M5): one JSON object per line in
 *   <userData>/evaluation/results.jsonl
 * so they can be analysed later (e.g. for the report).
 */
import { app, ipcMain, shell } from 'electron'
import { promises as fs } from 'fs'
import { join } from 'path'

const dir = (): string => join(app.getPath('userData'), 'evaluation')
const file = (): string => join(dir(), 'results.jsonl')
const MAX_BYTES = 256 * 1024

export function registerEvaluation(): void {
  ipcMain.handle('eval:append', async (_e, record: unknown) => {
    if (typeof record !== 'object' || !record) throw new Error('Bad arguments')
    const line = JSON.stringify(record)
    if (line.length > MAX_BYTES) throw new Error('Record too large')
    await fs.mkdir(dir(), { recursive: true })
    await fs.appendFile(file(), line + '\n')
    return true
  })

  ipcMain.handle('eval:list', async () => {
    try {
      const text = await fs.readFile(file(), 'utf8')
      return text
        .split('\n')
        .filter(Boolean)
        .flatMap((l) => {
          try {
            return [JSON.parse(l)]
          } catch {
            return []
          }
        })
    } catch {
      return []
    }
  })

  ipcMain.handle('eval:reveal', async () => {
    await fs.mkdir(dir(), { recursive: true })
    try {
      await fs.access(file())
      shell.showItemInFolder(file())
    } catch {
      shell.openPath(dir())
    }
    return true
  })
}
