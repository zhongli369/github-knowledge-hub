import { cookies } from "next/headers"
import type { Locale } from "./translations"
import { translations } from "./translations"

export async function getLocale(): Promise<Locale> {
  const cookieStore = await cookies()
  const locale = cookieStore.get("locale")?.value
  if (locale === "zh" || locale === "en") return locale
  return "zh"
}

export async function getTranslations() {
  const locale = await getLocale()
  return translations[locale]
}

export type { Locale }
