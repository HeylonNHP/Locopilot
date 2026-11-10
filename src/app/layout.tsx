import type { Metadata, Viewport } from 'next';
import { cookies } from 'next/headers';

import { DocumentHead } from './DocumentHead';
import { ChatProvider } from './lib/chatStore';

import './globals.scss';
import './styles.scss';

export const metadata: Metadata = {
  description: 'Local, Private, Safe AI Assistant',
};

// Mirror the two theme values the StatusBar toggle writes. Keep this in sync
// with the toggle in src/components/StatusBar/StatusBar.tsx.
const THEME_COOKIE = 'locopilot-theme';
const VALID_THEMES = new Set(['dark', 'frutiger-aero']);

// Single source of truth for "which theme is this request in". Both the <html>
// attribute and the colour-scheme meta derive from it, so they cannot disagree
// if a third theme is ever added.
async function resolveTheme(): Promise<string | undefined> {
  const cookieStore = await cookies();
  const themeCookie = cookieStore.get(THEME_COOKIE)?.value;
  return themeCookie && VALID_THEMES.has(themeCookie) ? themeCookie : undefined;
}

// Emit <meta name="color-scheme"> before first paint so the UA renders its own
// chrome (scrollbars, canvas, native controls) in the matching palette from the
// very first frame instead of flashing the light one. Derived from the resolved
// theme rather than `light dark` — that would follow the OS, which can disagree
// with the app theme.
export async function generateViewport(): Promise<Viewport> {
  return { colorScheme: (await resolveTheme()) === 'dark' ? 'dark' : 'light' };
}

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  // Read the theme from the cookie on the server so SSR and the first client
  // render agree on <html data-theme=...>. This eliminates the hydration
  // mismatch we previously suppressed. First-time visitors have no cookie,
  // so we omit the attribute entirely (matches the prior default).
  const initialTheme = await resolveTheme();

  return (
    <html lang="en" data-theme={initialTheme}>
      <body>
        <ChatProvider>
          <DocumentHead />
          {children}
        </ChatProvider>
      </body>
    </html>
  );
}
