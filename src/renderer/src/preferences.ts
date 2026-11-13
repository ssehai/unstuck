/**
 * The Preferences window (⌘,): LLM backend, model and API key.
 * Settings live in the main process (src/main/settings.ts); the saved key is
 * never sent back here, only whether one exists.
 */
export type BackendName = 'cli' | 'api'
export type ModelAlias = 'sonnet' | 'opus' | 'haiku'

export interface SettingsView {
  backend: BackendName
  model: ModelAlias
  hasApiKey: boolean
  envOverrides: string[]
  canEncrypt: boolean
}

export interface SettingsBridge {
  get(): Promise<SettingsView>
  set(patch: { backend?: BackendName; model?: ModelAlias; apiKey?: string | null }): Promise<SettingsView>
}

export function setupPreferences(dialog: HTMLElement): { refresh(): Promise<void> } {
  const bridge = window.unstuckApi?.settings
  const form = dialog.querySelector<HTMLFormElement>('.prefs-form')!
  const keyBox = form.querySelector<HTMLElement>('.prefs-key')!
  const keyInput = form.querySelector<HTMLInputElement>('input[name="apiKey"]')!
  const keyStatus = form.querySelector<HTMLElement>('.prefs-key-status')!
  const keyDelete = form.querySelector<HTMLButtonElement>('.prefs-key-delete')!
  const envNote = form.querySelector<HTMLElement>('.prefs-env')!
  const modelSelect = form.querySelector<HTMLSelectElement>('select[name="model"]')!
  const radios = [...form.querySelectorAll<HTMLInputElement>('input[name="backend"]')]

  if (!bridge) {
    // Plain-browser preview: nothing to configure.
    form.querySelectorAll('input, select, button').forEach((el) => ((el as HTMLInputElement).disabled = true))
    return { refresh: async () => undefined }
  }

  const show = (v: SettingsView): void => {
    for (const r of radios) r.checked = r.value === v.backend
    modelSelect.value = v.model
    keyBox.hidden = v.backend !== 'api'
    keyInput.value = ''
    keyStatus.textContent = v.hasApiKey ? '저장된 키 있음 (키체인으로 암호화)' : v.canEncrypt ? '저장된 키 없음' : '이 시스템에서는 키를 암호화할 수 없어요'
    keyDelete.hidden = !v.hasApiKey
    envNote.hidden = v.envOverrides.length === 0
    envNote.textContent = `환경 변수 ${v.envOverrides.join(', ')}가 설정되어 있어서, 이 앱에서는 그 값이 여기 설정보다 우선해요.`
  }

  const apply = async (patch: Parameters<SettingsBridge['set']>[0]): Promise<void> => {
    try {
      show(await bridge.set(patch))
    } catch (err) {
      keyStatus.textContent = `저장하지 못했어요: ${(err as Error).message}`
    }
  }

  for (const r of radios) r.addEventListener('change', () => r.checked && apply({ backend: r.value as BackendName }))
  modelSelect.addEventListener('change', () => apply({ model: modelSelect.value as ModelAlias }))
  form.addEventListener('submit', (e) => {
    e.preventDefault()
    const key = keyInput.value.trim()
    if (!key) return keyInput.focus()
    void apply({ apiKey: key })
  })
  keyDelete.addEventListener('click', () => apply({ apiKey: null }))
  // Typing here must not trigger the reader's shortcuts (Enter = ask, etc.).
  dialog.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') e.stopPropagation()
  })

  return { refresh: async () => show(await bridge.get()) }
}
