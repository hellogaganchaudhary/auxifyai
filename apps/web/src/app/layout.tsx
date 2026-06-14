import type { ReactNode } from 'react';
import './globals.css';
import { ThemeProvider } from '@/components/shell/ThemeProvider';

export const metadata = {
  title: 'Auxify Chat',
  description: 'Chat with AI models — Claude, GPT-5, and more.',
};

/**
 * Root layout. Wraps the app in the {@link ThemeProvider} (light/dark/system)
 * and renders the active screen full-bleed. The chat screen owns its own
 * ChatGPT-style layout, so there is no global app shell.
 */
export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" data-theme="system">
      <body data-theme="system">
        <ThemeProvider>{children}</ThemeProvider>
      </body>
    </html>
  );
}
