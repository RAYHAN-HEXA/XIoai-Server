import { getTranslations } from 'next-intl/server';
import { AppSidebar } from '@/components/app-sidebar';
import { AssistantChat } from '@/components/assistant/assistant-chat';
import { LanguageSwitcher } from '@/components/language-switcher';
import { LogoutButton } from '@/components/logout-button';

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const t = await getTranslations('nav');

  return (
    <div className="flex min-h-screen">
      <AppSidebar />
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-14 items-center justify-end gap-3 border-b bg-card px-4">
          <LanguageSwitcher />
          <LogoutButton label={t('logout')} />
        </header>
        <main className="flex-1 p-4 md:p-6">{children}</main>
      </div>
      <AssistantChat />
    </div>
  );
}
