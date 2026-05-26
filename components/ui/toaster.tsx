'use client';

import { Toaster as SonnerToaster } from 'sonner';

export function Toaster() {
  return (
    <SonnerToaster
      position="bottom-center"
      theme="dark"
      toastOptions={{
        style: {
          background: '#131313',
          border: '1px solid #2a2825',
          color: '#f5f0e6',
          fontFamily: 'var(--font-inter), system-ui, sans-serif',
          fontSize: '13px',
        },
      }}
    />
  );
}

export { toast } from 'sonner';
