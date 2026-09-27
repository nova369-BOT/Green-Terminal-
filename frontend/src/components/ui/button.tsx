import * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "@/lib/utils";

const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md border border-transparent text-[13px] font-medium transition-colors duration-150 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-neon-gold focus-visible:ring-offset-1 focus-visible:ring-offset-background disabled:pointer-events-none disabled:opacity-45 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        default: "border-primary bg-primary text-text-primary hover:brightness-110",
        destructive: "border-destructive bg-destructive text-white hover:brightness-110",
        outline: "border-border bg-transparent text-text-primary hover:border-muted-foreground hover:bg-muted",
        secondary: "border-border bg-secondary text-text-primary hover:bg-muted",
        ghost: "text-text-secondary hover:bg-muted hover:text-text-primary",
        link: "border-transparent px-0 text-text-primary underline-offset-4 hover:text-neon-gold hover:underline",
        premium: "border-neon-gold bg-transparent text-neon-gold hover:bg-neon-gold/10",
      },
      size: {
        default: "h-8 px-3 py-1.5",
        sm: "h-7 px-2.5",
        lg: "h-9 px-4 text-[13px]",
        icon: "h-8 w-8 p-0",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  },
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
  VariantProps<typeof buttonVariants> {
  asChild?: boolean;
}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild = false, ...props }, ref) => {
    const Comp = asChild ? Slot : "button";
    return <Comp className={cn(buttonVariants({ variant, size, className }))} ref={ref} {...props} />;
  },
);
Button.displayName = "Button";

export { Button, buttonVariants };
