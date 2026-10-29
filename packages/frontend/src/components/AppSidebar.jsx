import { Link, useLocation } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { Sun, Moon, ExternalLink } from 'lucide-react'
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuItem,
  SidebarMenuButton,
} from '@/components/ui/sidebar'
import { useApp } from '../context/AppContext'
import { navGroups, systemNavItems, navLabel } from '../lib/navItems'

export default function AppSidebar({ backendConnected, backendVersion, onStatusClick, ...props }) {
  const { t } = useTranslation('layout')
  const { isDark, toggleTheme, isAdmin } = useApp()
  const location = useLocation()

  const visibleSystemItems = systemNavItems.filter((item) => !item.adminOnly || isAdmin)

  const isActive = (to) => {
    if (to === '/') return location.pathname === '/'
    return location.pathname === to || location.pathname.startsWith(to + '/')
  }

  return (
    <Sidebar variant="inset" collapsible="icon" {...props}>
      <SidebarHeader className="p-0">
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton size="lg" className="!p-0 group-data-[collapsible=icon]:!size-auto" asChild>
              <Link to="/">
                <img
                  src="/logo.png"
                  alt="RaceHubOS"
                  className="size-10 shrink-0 object-contain group-data-[collapsible=icon]:size-full"
                />
                <div className="grid flex-1 text-left text-sm leading-tight">
                  <span className="truncate font-bold">RaceHubOS</span>
                  <span className="truncate text-xs text-muted-foreground">Carrera Digital 132/124</span>
                </div>
              </Link>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>

      <SidebarContent>
        {navGroups.map((group) => (
          <SidebarGroup key={group.labelKey} role="group" aria-label={t(group.labelKey)}>
            <SidebarGroupLabel>{t(group.labelKey)}</SidebarGroupLabel>
            <SidebarGroupContent>
              <SidebarMenu>
                {group.items.map((item) => {
                  const label = navLabel(t, item)
                  return (
                    <SidebarMenuItem key={item.to}>
                      <SidebarMenuButton asChild isActive={isActive(item.to)} tooltip={label}>
                        <Link
                          to={item.to}
                          target={item.standalone ? '_blank' : undefined}
                          rel={item.standalone ? 'noopener noreferrer' : undefined}
                        >
                          <item.Icon />
                          <span>{label}</span>
                          {item.standalone && (
                            <>
                              <ExternalLink className="ml-auto" aria-hidden="true" />
                              <span className="sr-only">{t('nav.newWindow')}</span>
                            </>
                          )}
                        </Link>
                      </SidebarMenuButton>
                    </SidebarMenuItem>
                  )
                })}
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        ))}
      </SidebarContent>

      <SidebarFooter>
        <SidebarMenu>
          {visibleSystemItems.map((item) => {
            const label = navLabel(t, item)
            return (
              <SidebarMenuItem key={item.to}>
                <SidebarMenuButton asChild isActive={isActive(item.to)} tooltip={label}>
                  <Link to={item.to}>
                    <item.Icon />
                    <span>{label}</span>
                  </Link>
                </SidebarMenuButton>
              </SidebarMenuItem>
            )
          })}
          <SidebarMenuItem>
            <SidebarMenuButton onClick={toggleTheme} tooltip={isDark ? t('theme.dayMode') : t('theme.nightMode')}>
              {isDark ? <Sun /> : <Moon />}
              <span>{isDark ? t('theme.dayMode') : t('theme.nightMode')}</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
          <SidebarMenuItem>
            <SidebarMenuButton
              onClick={onStatusClick}
              tooltip={backendConnected ? t('backend.connectedTooltip') : t('backend.disconnectedTooltip')}
            >
              <div
                className={`size-2 rounded-full shrink-0 ${backendConnected ? 'bg-green-500 animate-pulse' : 'bg-red-500'}`}
              />
              <span className="text-xs truncate">
                {backendConnected ? t('backend.connected', { version: backendVersion }) : t('backend.disconnected')}
              </span>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>
    </Sidebar>
  )
}
