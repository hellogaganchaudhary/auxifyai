import { ChatApp } from './ChatApp';
import { AuthGate } from '@/components/AuthGate';

/** The chat screen — gated behind the shared application login. */
export default function ChatPage() {
  return (
    <AuthGate>
      <ChatApp />
    </AuthGate>
  );
}
