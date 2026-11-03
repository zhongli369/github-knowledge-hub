"use client"

import { useLanguage } from "@/i18n/LanguageProvider"
import { Languages } from "lucide-react"

export function LanguageSwitcher() {
  const { locale, setLocale } = useLanguage()

  return (
    <button
      onClick={() => setLocale(locale === "zh" ? "en" : "zh")}
      className="inline-flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors px-2 py-1 rounded-md border"
      title={locale === "zh" ? "Switch to English" : "切换到中文"}
    >
      <Languages className="size-3.5" />
      {locale === "zh" ? "EN" : "中文"}
    </button>
  )
}
