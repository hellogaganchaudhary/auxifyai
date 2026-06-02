import type { ReactNode } from 'react';
import './globals.css';
import { ThemeProvider } from '@/components/shell/ThemeProvider';
import { AppShell } from '@/components/shell/AppShell';

export const metadata = {
  title: 'Auxify AI Platform',
  description: 'Enterprise AI platform',
};

/**
 * Root layout for the web client.
 *
 * Imports the global stylesheet (which defines the theme tokens), wraps the
 * tree in the {@link ThemeProvider} for light/dark/system switching (Req 40.4),
 * and renders every screen inside the {@link AppShell} three-region layout
 * (Req 40.1). The initial `data-theme="system"` on `<html>` matches the
 * provider's default so the first paint already follows the OS preference.
 */
export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" data-theme="system">
      <body data-theme="system">
        <ThemeProvider>
          <AppShell>{children}</AppShell>
        </ThemeProvider>
      </body>
    </html>
  );
}
