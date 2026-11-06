/// <reference types="vite/client" />

interface Window {
  unstuckApi?: {
    platform: string
    library: import('./library').Library
    llm: import('./llm').LlmBridge
    notes: import('./notes').NotesStore
    onMenu?: (cb: (command: string) => void) => () => void
  }
}
