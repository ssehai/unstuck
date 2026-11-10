/**
 * Application menu. Electron's default View menu binds ⌘+ / ⌘− / ⌘0 to
 * zooming the *whole window* (toolbar and panel included). Here those keys
 * zoom the PDF instead, ⌘⇧+ / ⌘⇧− change the panel's text size, and ⌘,
 * opens Preferences — all by forwarding a command to the renderer.
 */
import { app, BrowserWindow, Menu, type MenuItemConstructorOptions } from 'electron'

function send(command: string): void {
  BrowserWindow.getFocusedWindow()?.webContents.send('menu:command', command)
}

export function installMenu(): void {
  const isMac = process.platform === 'darwin'
  const preferences: MenuItemConstructorOptions = {
    label: 'Preferences…',
    accelerator: 'CmdOrCtrl+,',
    click: () => send('preferences')
  }
  const template: MenuItemConstructorOptions[] = [
    ...(isMac
      ? [
          {
            label: app.name,
            submenu: [
              { role: 'about' as const },
              { type: 'separator' as const },
              preferences,
              { type: 'separator' as const },
              { role: 'services' as const },
              { type: 'separator' as const },
              { role: 'hide' as const },
              { role: 'hideOthers' as const },
              { role: 'unhide' as const },
              { type: 'separator' as const },
              { role: 'quit' as const }
            ]
          }
        ]
      : []),
    isMac ? { role: 'fileMenu' } : { label: 'File', submenu: [preferences, { type: 'separator' }, { role: 'quit' }] },
    { role: 'editMenu' },
    {
      label: 'View',
      submenu: [
        { label: 'Zoom In', accelerator: 'CmdOrCtrl+=', click: () => send('zoom-in') },
        { label: 'Zoom Out', accelerator: 'CmdOrCtrl+-', click: () => send('zoom-out') },
        { label: 'Fit to Width', accelerator: 'CmdOrCtrl+0', click: () => send('zoom-fit') },
        { type: 'separator' },
        { label: 'Find in Paper', accelerator: 'CmdOrCtrl+F', click: () => send('find-paper') },
        { label: 'Find in Panel', accelerator: 'CmdOrCtrl+Shift+F', click: () => send('find-panel') },
        { label: 'Find Next', accelerator: 'CmdOrCtrl+G', click: () => send('find-next') },
        { label: 'Find Previous', accelerator: 'CmdOrCtrl+Shift+G', click: () => send('find-prev') },
        { type: 'separator' },
        { label: 'Panel Text Larger', accelerator: 'CmdOrCtrl+Shift+=', click: () => send('panel-font-up') },
        { label: 'Panel Text Smaller', accelerator: 'CmdOrCtrl+Shift+-', click: () => send('panel-font-down') },
        { label: 'Panel Text Default Size', click: () => send('panel-font-reset') },
        { type: 'separator' },
        { label: 'Evaluation Mode (blind A/B)', accelerator: 'CmdOrCtrl+Shift+E', click: () => send('toggle-eval') },
        { type: 'separator' },
        { role: 'reload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'togglefullscreen' }
      ]
    },
    { role: 'windowMenu' }
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}
