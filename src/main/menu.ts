/**
 * Application menu. Electron's default View menu binds ⌘+ / ⌘− / ⌘0 to
 * zooming the *whole window* (toolbar and panel included). Here those keys
 * zoom the PDF instead, by forwarding a command to the renderer.
 */
import { BrowserWindow, Menu, type MenuItemConstructorOptions } from 'electron'

function send(command: string): void {
  BrowserWindow.getFocusedWindow()?.webContents.send('menu:command', command)
}

export function installMenu(): void {
  const isMac = process.platform === 'darwin'
  const template: MenuItemConstructorOptions[] = [
    ...(isMac ? [{ role: 'appMenu' as const }] : []),
    { role: 'fileMenu' },
    { role: 'editMenu' },
    {
      label: 'View',
      submenu: [
        { label: 'Zoom In', accelerator: 'CmdOrCtrl+=', click: () => send('zoom-in') },
        // ⌘+ (with Shift) as well, without a second visible entry.
        { label: 'Zoom In', accelerator: 'CmdOrCtrl+Plus', click: () => send('zoom-in'), visible: false, acceleratorWorksWhenHidden: true },
        { label: 'Zoom Out', accelerator: 'CmdOrCtrl+-', click: () => send('zoom-out') },
        { label: 'Fit to Width', accelerator: 'CmdOrCtrl+0', click: () => send('zoom-fit') },
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
