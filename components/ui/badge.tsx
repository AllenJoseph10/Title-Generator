import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '@/lib/utils';

const badgeVariants = cva(
  'inline-flex items-center px-2 py-0.5 text-micro uppercase tracking-[0.08em] font-medium',
  {
    variants: {
      variant: {
        positive: 'bg-positive/10 text-positive border border-positive/30',
        warning: 'bg-warning/10 text-warning border border-warning/30',
        neutral: 'bg-bg-inset text-ink-muted border border-border',
        outline: 'border border-border text-ink-dim',
      },
    },
    defaultVariants: { variant: 'neutral' },
  },
);

export interface BadgeProps
  extends React.HTMLAttributes<HTMLSpanElement>,
    VariantProps<typeof badgeVariants> {}

export function Badge({ className, variant, ...props }: BadgeProps) {
  return <span className={cn(badgeVariants({ variant, className }))} {...props} />;
}
