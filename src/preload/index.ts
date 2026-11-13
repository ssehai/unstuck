import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'

// The renderer only gets these narrow functions, never ipcRenderer itself.
contextBridge.exposeInMainWorld('unstuckApi', {
  platform: process.platform,
  onMenu: (cb: (command: string) => void) => {
    const listener = (_e: IpcRendererEvent, command: string): void => cb(command)
    ipcRenderer.on('menu:command', listener)
    return () => ipcRenderer.removeListener('menu:command', listener)
  },
  library: {
    list: () => ipcRenderer.invoke('library:list'),
    add: (name: string, data: Uint8Array) => ipcRenderer.invoke('library:add', name, data),
    read: (id: string) => ipcRenderer.invoke('library:read', id),
    update: (id: string, patch: object) => ipcRenderer.invoke('library:update', id, patch),
    remove: (id: string) => ipcRenderer.invoke('library:remove', id)
  },
  notes: {
    list: (paperId: string) => ipcRenderer.invoke('notes:list', paperId),
    put: (paperId: string, record: object) => ipcRenderer.invoke('notes:put', paperId, record),
    remove: (paperId: string, id: string) => ipcRenderer.invoke('notes:remove', paperId, id)
  },
  evaluation: {
    append: (record: object) => ipcRenderer.invoke('eval:append', record),
    list: () => ipcRenderer.invoke('eval:list'),
    reveal: () => ipcRenderer.invoke('eval:reveal')
  },
  settings: {
    get: () => ipcRenderer.invoke('settings:get'),
    set: (patch: object) => ipcRenderer.invoke('settings:set', patch)
  },
  llm: {
    explain: (req: object) => ipcRenderer.invoke('llm:explain', req),
    cancel: (id: string) => ipcRenderer.invoke('llm:cancel', id),
    onEvent: (cb: (ev: unknown) => void) => {
      const listener = (_e: IpcRendererEvent, ev: unknown): void => cb(ev)
      ipcRenderer.on('llm:event', listener)
      return () => ipcRenderer.removeListener('llm:event', listener)
    }
  }
})
