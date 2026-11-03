"use client"

import Link from "next/link"
import { usePathname } from "next/navigation"
import {
  Github,
  Library,
  Layers,
  Code,
  Search,
  Sparkles,
  type LucideIcon,
} from "lucide-react"

import {
  SidebarGroup,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@/components/ui/sidebar"
import { useLanguage } from "@/i18n/LanguageProvider"

interface NavItem {
  key: string
  url: string
  icon: LucideIcon
}

const mainNav: NavItem[] = [
  { key: "browseRepos", url: "/repos", icon: Github },
  { key: "knowledgeLibrary", url: "/library", icon: Library },
  { key: "collections", url: "/collections", icon: Layers },
  { key: "assets", url: "/assets", icon: Code },
  { key: "discover", url: "/discover", icon: Search },
  { key: "analyses", url: "/analyses", icon: Sparkles },
]

export function NavMain() {
  const pathname = usePathname()
  const { t } = useLanguage()

  return (
    <SidebarGroup>
      <SidebarGroupLabel>Platform</SidebarGroupLabel>
      <SidebarMenu>
        {mainNav.map((item) => (
          <SidebarMenuItem key={item.url}>
            <SidebarMenuButton
              isActive={pathname.startsWith(item.url)}
              tooltip={t.nav[item.key as keyof typeof t.nav]}
              render={(props) => <Link href={item.url} {...props} />}
            >
              <item.icon />
              <span>{t.nav[item.key as keyof typeof t.nav]}</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
        ))}
      </SidebarMenu>
    </SidebarGroup>
  )
}
