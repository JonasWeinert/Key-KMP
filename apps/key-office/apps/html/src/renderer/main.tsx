import { createRoot } from 'react-dom/client'
import { htmlLang, type Lang } from '@key/i18n'
import App from './App'
import { PresentView } from './PresentView'
import { LocaleProvider } from './i18n/locale'
import type { UiTheme } from '../shared/ipc'
import { applyAiPanelPrefs, installScreenTips } from '@key/ui'
import '@key/ui/tokens.css'
import '@key/ui/screentip.css'
import '@key/ui/dropdown.css'
import '@key/ui/find-panel.css'
import '@key/ui/color-picker.css'
import '@key/ui/ribbon-collapse.css'
import '@key/ui/ai-panel-prefs.css'
import '@key/ui/ai-scope-quote.css'
import '@key/ui/image-dialogs.css'
import './styles.css'
import '@key/design-system/styles.css'
import '@key/design-system/office.css'

if (!new URLSearchParams(location.search).has('present'))
  document.body.classList.add('key-office-ui')

installScreenTips()

function applyTheme(theme: UiTheme): void {
  if (theme === 'system') document.documentElement.removeAttribute('data-theme')
  else document.documentElement.setAttribute('data-theme', theme)
}

void (async () => {
  const [lang, theme] = await Promise.all([
    window.htmlApi.getLanguage().catch(() => 'zh' as const),
    window.htmlApi.getTheme().catch(() => 'system' as const),
  ])
  document.documentElement.lang = htmlLang(lang as Lang)
  applyTheme(theme)
  window.htmlApi.onThemeChanged(applyTheme)
  void window.htmlApi
    ?.getAiPanelPrefs?.()
    .then(applyAiPanelPrefs)
    .catch(() => {})
  window.htmlApi?.onAiPanelPrefsChanged?.(applyAiPanelPrefs)
  // a present tab/window (opened by Present → New tab) renders only its owner's preview
  const params = new URLSearchParams(location.search)
  const present = params.has('present')
  createRoot(document.getElementById('root')!).render(
    <LocaleProvider initial={lang}>
      {present ? <PresentView title={params.get('title') ?? ''} /> : <App />}
    </LocaleProvider>,
  )
})()
