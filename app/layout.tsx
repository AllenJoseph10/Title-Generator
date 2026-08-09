import './globals.css';
import { Inter, Fraunces } from 'next/font/google';
import { Toaster } from '@/components/ui/toaster';

const inter = Inter({
  subsets: ['latin'],
  variable: '--font-inter',
  weight: ['400', '500', '600'],
  display: 'swap',
});

const fraunces = Fraunces({
  subsets: ['latin'],
  variable: '--font-fraunces',
  axes: ['opsz'],
  display: 'swap',
});

export const metadata = {
  title: 'Hook Title Generator',
  description:
    'Drop in a silent clip and get five burned-in title ideas, ranked against real titles whose performance has already been measured.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${inter.variable} ${fraunces.variable}`}>
      <body className="min-h-screen bg-bg text-ink antialiased">
        {children}
        <Toaster />
      </body>
    </html>
  );
}
