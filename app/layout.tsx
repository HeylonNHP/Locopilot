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
      <body>
        <ChatProvider>{children}</ChatProvider>
      </body>
    </html>
  );
}
