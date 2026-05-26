import * as React from 'react';
import { Slot } from '@radix-ui/react-slot';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '@/lib/utils';

const buttonVariants = cva(
  'inline-flex items-center justify-center gap-2 whitespace-nowrap font-medium transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent disabled:pointer-events-none disabled:opacity-40',
  {
    variants: {
      variant: {
        default: 'bg-accent text-ink hover:bg-accent-hover',
        outline: 'border border-border-strong bg-transparent text-ink hover:bg-bg-raised',
        ghost: 'text-ink hover:bg-bg-raised',
        subtle: 'bg-bg-raised text-ink hover:bg-bg-inset',
        link: 'text-ink underline-offset-4 hover:underline',
      },
      size: {
        default: 'h-9 px-4 text-sm rounded-md',
        sm: 'h-8 px-3 text-xs rounded-sm',
        icon: 'h-8 w-8 rounded-sm',
        lg: 'h-11 px-6 text-base rounded-md',
      },
    },
    defaultVariants: { variant: 'default', size: 'default' },
  },
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean;
}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild = false, ...props }, ref) => {
    const Comp = asChild ? Slot : 'button';
    return <Comp className={cn(buttonVariants({ variant, size, className }))} ref={ref} {...props} />;
  },
);
Button.displayName = 'Button';

export { buttonVariants };
