import { app, BrowserWindow, shell } from 'electron'
import { join } from 'path'
import { registerLibrary } from './library'
import { registerLlm } from './llm'
import { installMenu } from './menu'
import { registerNotes } from './notes'
import { registerEvaluation } from './evaluation'

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

app.whenReady().then(() => {
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
