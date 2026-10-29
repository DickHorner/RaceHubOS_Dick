import { Link, useLocation } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { Sun, Moon, ExternalLink, House } from 'lucide-react'
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuItem,
  SidebarMenuButton,
  SidebarMenuSub,
  SidebarMenuSubItem,
  SidebarMenuSubButton,
} from '@/components/ui/sidebar'
import { useApp } from '../context/AppContext'
import { navGroups, systemNavItems, navLabel } from '../lib/navItems'

export default function AppSidebar({ backendConnected, backendVersion, onStatusClick, ...props }) {
  const { t } = useTranslation('layout')
  const { isDark, toggleTheme, isAdmin } = useApp()
  const location = useLocation()

  const visibleSystemItems = systemNavItems.filter((item) => !item.adminOnly || isAdmin)

  const isActive = (to) => location.pathname === to || (to !== '/' && location.pathname.startsWith(to + '/'))
  const isGroupActive = (group) => isActive(group.to) || group.items.some((item) => isActive(item.to))

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
                  <span className="truncate font-bold">RaceHub OG</span>
                  <span className="truncate text-xs text-muted-foreground">Carrera Digital 132/124</span>
                </div>
              </Link>
            </SidebarMenuButton>
          </SidebarMenuItem>
          <SidebarMenuItem>
            <SidebarMenuButton asChild isActive={isActive('/')} tooltip={t('nav.home')}>
              <Link to="/">
                <House />
                <span>{t('nav.home')}</span>
              </Link>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>

      <SidebarContent>
        {navGroups.map((group) => (
          <SidebarGroup key={group.id} role="group" aria-label={t(group.labelKey)}>
            <SidebarGroupContent>
              <SidebarMenu>
                <SidebarMenuItem>
                  <SidebarMenuButton asChild size="lg" isActive={isGroupActive(group)} tooltip={t(group.labelKey)}>
                    <Link to={group.to}>
                      <group.Icon />
                      <span className="font-semibold">{t(group.labelKey)}</span>
                    </Link>
                  </SidebarMenuButton>
                  {isGroupActive(group) && (
                    <SidebarMenuSub>
                      {group.items.map((item) => {
                        const label = navLabel(t, item)
                        return (
                          <SidebarMenuSubItem key={item.to}>
                            <SidebarMenuSubButton asChild isActive={isActive(item.to)}>
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
                            </SidebarMenuSubButton>
                          </SidebarMenuSubItem>
                        )
                      })}
                    </SidebarMenuSub>
                  )}
                </SidebarMenuItem>
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
