import type { Metadata } from 'next';
import './globals.scss';
import './styles.scss';
import { ChatProvider } from './lib/chatStore';

export const metadata: Metadata = {
  title: 'Locopilot',
  description: 'Local, Private, Safe AI Assistant',
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      {/* Inline script runs synchronously before first paint to set data-theme and prevent FOUC */}
      <head>
        <script
          dangerouslySetInnerHTML={{
            __html: `(function(){try{var t=localStorage.getItem('locopilot-theme');if(t==='dark')document.documentElement.setAttribute('data-theme','dark');}catch(e){}})();`,
          }}
        />
      </head>
      <body>
        <ChatProvider>{children}</ChatProvider>
      </body>
    </html>
  );
}
