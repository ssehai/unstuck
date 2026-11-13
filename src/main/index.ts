import { app, BrowserWindow, dialog, shell } from 'electron'
import { join } from 'path'
import { registerLibrary } from './library'
import { registerLlm } from './llm'
import { installMenu } from './menu'
import { registerNotes } from './notes'
import { registerEvaluation } from './evaluation'
import { registerSettings } from './settings'

// One data folder for every way of running the app: `npm run dev` (named
// "unstuck" after package.json) and the packaged Unstuck.app share the same
// library, notes and settings.
app.setPath('userData', join(app.getPath('appData'), 'unstuck'))

/**
 * Only one copy may run at a time, since two would overwrite each other's
 * notes. The lock is tied to the data folder, so it also stops the packaged
 * app and `npm run dev` from running together. In development the previous
 * process may still be exiting when electron-vite restarts it, so retry briefly.
 */
async function acquireSingleInstance(): Promise<boolean> {
  const deadline = Date.now() + (app.isPackaged ? 0 : 5000)
  for (;;) {
    if (app.requestSingleInstanceLock()) return true
    if (Date.now() >= deadline) return false
    await new Promise((r) => setTimeout(r, 300))
  }
}

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1280,
    height: 880,
    minWidth: 720,
    minHeight: 500,
    title: 'Unstuck',
    backgroundColor: '#f4f4f2',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      sandbox: true
    }
  })

  // Links inside PDFs open in the system browser, never inside the app.
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: 'deny' }
  })

  if (!app.isPackaged && process.env['ELECTRON_RENDERER_URL']) {
    win.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

app.on('second-instance', () => {
  const win = BrowserWindow.getAllWindows()[0]
  if (!win) return
  if (win.isMinimized()) win.restore()
  win.focus()
})

acquireSingleInstance().then(async (ok) => {
  if (!ok) {
    const msg = 'Unstuck is already running (the app, or `npm run dev`). Quit it first; two copies would overwrite each other\'s notes.'
    console.error(msg)
    if (app.isPackaged) {
      await app.whenReady()
      dialog.showErrorBox('Unstuck is already running', msg)
    }
    app.exit(0)
    return
  }
  await app.whenReady()
  registerSettings()
  registerLibrary()
  registerLlm()
  registerNotes()
  registerEvaluation()
  installMenu()
  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
