import type { Metadata } from "next"
import { cookies } from "next/headers"
import { Geist, Geist_Mono } from "next/font/google"
import { Providers } from "@/components/providers"
import { TooltipProvider } from "@/components/ui/tooltip"
import { LanguageProvider } from "@/i18n/LanguageProvider"
import type { Locale } from "@/i18n/translations"
import "./globals.css"

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
})

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
})

export const metadata: Metadata = {
  title: "GitHub Knowledge Hub",
  description: "Personal GitHub knowledge asset management",
}

export default async function RootLayout({
  children,
}: {
  children: React.ReactNode
}) {
  const cookieStore = await cookies()
  const initialLocale = (cookieStore.get("locale")?.value === "en" ? "en" : "zh") as Locale

  return (
    <html lang={initialLocale === "zh" ? "zh-CN" : "en"} suppressHydrationWarning>
      <body
        className={`${geistSans.variable} ${geistMono.variable} font-sans antialiased`}
      >
        <LanguageProvider initialLocale={initialLocale}>
          <Providers>
            <TooltipProvider>{children}</TooltipProvider>
          </Providers>
        </LanguageProvider>
      </body>
    </html>
  )
}
