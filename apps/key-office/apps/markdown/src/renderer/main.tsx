import { createRoot } from 'react-dom/client'
import { htmlLang, type Lang } from '@key/i18n'
import App from './App'
import { LocaleProvider } from './i18n/locale'
import type { UiTheme } from '../shared/ipc'
import '@key/ui/tokens.css'
import '@key/ui/screentip.css'
import '@key/ui/dropdown.css'
import '@key/ui/find-panel.css'
import '@key/ui/ribbon-collapse.css'
import '@key/ui/markdown.css'
import '@key/ui/ai-panel-prefs.css'
import '@key/ui/ai-scope-quote.css'
import 'katex/dist/katex.min.css'
import './styles.css'
import '@key/design-system/styles.css'
import '@key/design-system/office.css'
import { applyAiPanelPrefs, installScreenTips } from '@key/ui'

document.body.classList.add('key-office-ui')

installScreenTips()

function applyTheme(theme: UiTheme): void {
  if (theme === 'system') document.documentElement.removeAttribute('data-theme')
  else document.documentElement.setAttribute('data-theme', theme)
}

void (async () => {
  const [lang, theme] = await Promise.all([
    window.markdownApi.getLanguage().catch(() => 'zh' as const),
    window.markdownApi.getTheme().catch(() => 'system' as const),
  ])
  document.documentElement.lang = htmlLang(lang as Lang)
  applyTheme(theme)
  window.markdownApi.onThemeChanged(applyTheme)
  void window.markdownApi
    ?.getAiPanelPrefs?.()
    .then(applyAiPanelPrefs)
    .catch(() => {})
  window.markdownApi?.onAiPanelPrefsChanged?.(applyAiPanelPrefs)
  createRoot(document.getElementById('root')!).render(
    <LocaleProvider initial={lang}>
      <App />
    </LocaleProvider>,
  )
})()
