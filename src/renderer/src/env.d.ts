/// <reference types="vite/client" />

interface Window {
  unstuckApi?: {
    platform: string
    library: import('./library').Library
    llm: import('./llm').LlmBridge
    notes: import('./notes').NotesStore
    evaluation: import('./evaluation').EvalStore
    settings?: import('./preferences').SettingsBridge
    onMenu?: (cb: (command: string) => void) => () => void
  }
}
