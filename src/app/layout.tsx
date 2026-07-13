import type { Metadata } from 'next';
import { cookies } from 'next/headers';

import { ChatProvider } from './lib/chatStore';

import './globals.scss';
import './styles.scss';

export const metadata: Metadata = {
  title: 'Locopilot',
  description: 'Local, Private, Safe AI Assistant',
};

// Mirror the two theme values the StatusBar toggle writes. Keep this in sync
// with the toggle in src/components/StatusBar/StatusBar.tsx.
const THEME_COOKIE = 'locopilot-theme';
const VALID_THEMES = new Set(['dark', 'frutiger-aero']);

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  // Read the theme from the cookie on the server so SSR and the first client
  // render agree on <html data-theme=...>. This eliminates the hydration
  // mismatch we previously suppressed. First-time visitors have no cookie,
  // so we omit the attribute entirely (matches the prior default).
  const cookieStore = await cookies();
  const themeCookie = cookieStore.get(THEME_COOKIE)?.value;
  const initialTheme = themeCookie && VALID_THEMES.has(themeCookie) ? themeCookie : undefined;

  return (
    <html lang="en" data-theme={initialTheme}>
      <body>
        <ChatProvider>{children}</ChatProvider>
      </body>
    </html>
  );
}
