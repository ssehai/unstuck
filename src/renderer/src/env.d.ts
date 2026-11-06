/// <reference types="vite/client" />

interface Window {
  unstuckApi?: {
    platform: string
    library: import('./library').Library
    llm: import('./llm').LlmBridge
    onMenu?: (cb: (command: string) => void) => () => void
  }
}
