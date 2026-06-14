import { redirect } from 'next/navigation';

/** The app is a chat product; the root redirects straight into the chat. */
export default function HomePage() {
  redirect('/chat');
}
