"use client"

import { createContext, useContext, useState, useEffect, useCallback } from "react"
import type { Locale } from "./translations"
import { translations } from "./translations"

type T = typeof translations.zh

const LanguageContext = createContext<{
  locale: Locale
  t: T
  setLocale: (locale: Locale) => void
} | null>(null)

export function LanguageProvider({
  children,
  initialLocale = "zh" as Locale,
}: {
  children: React.ReactNode
  initialLocale?: Locale
}) {
  const [locale, setLocaleState] = useState<Locale>(initialLocale)

  const setLocale = useCallback((newLocale: Locale) => {
    setLocaleState(newLocale)
    document.cookie = `locale=${newLocale};path=/;max-age=${365 * 24 * 60 * 60};SameSite=Lax`
    try {
      localStorage.setItem("locale", newLocale)
    } catch {
      // localStorage may be unavailable
    }
  }, [])

  useEffect(() => {
    try {
      const stored = localStorage.getItem("locale")
      if (stored === "zh" || stored === "en") {
        setLocaleState(stored)
        document.cookie = `locale=${stored};path=/;max-age=${365 * 24 * 60 * 60};SameSite=Lax`
      }
    } catch {
      // localStorage may be unavailable
    }
  }, [])

  return (
    <LanguageContext.Provider value={{ locale, t: translations[locale], setLocale }}>
      {children}
    </LanguageContext.Provider>
  )
}

export function useLanguage() {
  const ctx = useContext(LanguageContext)
  if (!ctx) throw new Error("useLanguage must be used within LanguageProvider")
  return ctx
}
