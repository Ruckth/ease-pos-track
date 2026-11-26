import * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

const buttonVariants = cva(
  "inline-flex [@media(pointer:coarse)]:min-h-11 [@media(pointer:coarse)]:min-w-11 items-center justify-center gap-2 whitespace-nowrap rounded-lg border text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background disabled:pointer-events-none disabled:opacity-50 aria-[busy=true]:cursor-progress [&_svg]:size-4 [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        default: "glass-action border-transparent bg-primary text-primary-foreground hover:bg-primary/90 active:bg-primary/80",
        secondary: "glass-action border-transparent bg-secondary text-secondary-foreground hover:bg-secondary/80 active:bg-secondary/70",
        outline: "aurora-control text-foreground hover:bg-muted active:bg-muted/80",
        ghost: "border-transparent hover:bg-field hover:text-foreground active:bg-muted",
        destructive: "border-transparent bg-destructive text-destructive-foreground hover:bg-destructive/90 active:bg-destructive/80",
      },
      // Compact 32 px, standard 36 px; touch sizes give 44 px phone targets.
      size: {
        default: "h-9 px-4 py-1.5",
        sm: "h-8 rounded-md px-3",
        lg: "h-11 rounded-md px-6",
        touch: "h-11 min-w-11 px-4",
        icon: "size-9 p-0",
        "icon-sm": "size-8 p-0",
        "icon-touch": "size-11 p-0",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  },
);

interface ButtonProps
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
