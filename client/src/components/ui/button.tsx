import { Button as ButtonPrimitive } from "@base-ui/react/button";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "@/lib/utils";

const buttonVariants = cva(
  "group/button inline-flex shrink-0 items-center justify-center rounded-lg border border-transparent bg-clip-padding text-sm font-medium whitespace-nowrap transition-all outline-none select-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 active:translate-y-px disabled:pointer-events-none disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20 dark:aria-invalid:border-destructive/50 dark:aria-invalid:ring-destructive/40 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  {
    variants: {
      variant: {
        // shadcn design-token variants
        default: "bg-primary text-primary-foreground [a]:hover:bg-primary/80",
        outline: "border-border bg-background hover:bg-muted hover:text-foreground aria-expanded:bg-muted aria-expanded:text-foreground dark:border-input dark:bg-input/30 dark:hover:bg-input/50",
        secondary: "bg-secondary text-secondary-foreground hover:bg-secondary/80 aria-expanded:bg-secondary aria-expanded:text-secondary-foreground",
        ghost: "hover:bg-muted hover:text-foreground aria-expanded:bg-muted aria-expanded:text-foreground dark:hover:bg-muted/50",
        destructive:
          "bg-destructive/10 text-destructive hover:bg-destructive/20 focus-visible:border-destructive/40 focus-visible:ring-destructive/20 dark:bg-destructive/20 dark:hover:bg-destructive/30 dark:focus-visible:ring-destructive/40",
        link: "text-primary underline-offset-4 hover:underline",

        // App design-token variants (use app-* CSS vars)
        "app-outline": "!border-app-border-input text-app-text-secondary hover:text-app-text rounded",
        "app-primary": "bg-app-accent text-app-on-filled hover:bg-app-accent-hover rounded disabled:bg-app-accent/40 disabled:opacity-100",
        "app-ghost": "text-app-text-secondary hover:text-app-text rounded",
        "app-danger": "bg-status-danger text-app-on-filled hover:bg-status-danger-hover rounded",
        "menu-action": "w-full !justify-start !rounded-none !px-3 !py-1.5 text-left text-app-text hover:bg-app-surface-hover",
        "close-action": "size-7 !rounded-md text-app-text-muted hover:bg-app-surface-hover hover:text-app-text",
        "destructive-outline": "!border-status-danger/40 text-status-danger hover:border-status-danger/60 hover:bg-status-danger/10",
        "selected-toggle": "border-app-accent bg-app-accent/15 text-app-accent hover:bg-app-accent/25",
        "full-width-action": "w-full",
        "form-section-toggle": "w-full !justify-between !rounded-none !py-2 text-left",
        "analysis-summary": "w-full !justify-start !gap-2 bg-status-success/10 !px-2 !py-1.5 text-left hover:bg-status-success/15",
        "settings-nav": "shrink-0 md:w-full !justify-start !rounded-none !px-4 !py-2 text-sm whitespace-nowrap transition-colors text-app-text-muted hover:text-app-text hover:bg-app-surface-hover",
        "settings-nav-selected": "shrink-0 md:w-full !justify-start !rounded-none !px-4 !py-2 text-sm whitespace-nowrap transition-colors text-app-accent bg-app-accent/10 border-b-2 md:border-b-0 md:border-r-2 border-app-accent",
        "focus-option": "!w-full !justify-start !rounded-lg !border !py-2 text-left transition-colors border-app-border hover:border-app-accent/50",
        "focus-option-selected": "!w-full !justify-start !rounded-lg !border !py-2 text-left transition-colors border-app-accent bg-app-accent/10",
        "search-select-trigger": "rounded border border-app-border-input px-3 py-2 text-sm text-app-text-secondary outline-none transition-colors hover:text-app-text focus-visible:border-app-accent focus-visible:ring-1 focus-visible:ring-app-accent/30 md:px-2 md:py-0.5 md:text-app-compact",
        "search-select-clear": "px-2 py-2 text-sm text-app-text-dim outline-none transition-colors hover:text-app-text focus-visible:text-app-text md:px-1 md:py-0.5 md:text-app-compact",
        "focus-toggle": "!rounded-none text-xs transition-colors text-app-text-dim hover:text-app-text hover:bg-app-surface-hover/30",
        "focus-toggle-driver": "!rounded-none text-xs transition-colors bg-(--focus-driver)/20 text-(--focus-driver) font-semibold",
        "focus-toggle-setup": "!rounded-none text-xs transition-colors bg-(--focus-setup)/20 text-(--focus-setup) font-semibold",
      },
      size: {
        default: "h-8 gap-1.5 px-2.5 has-data-[icon=inline-end]:pr-2 has-data-[icon=inline-start]:pl-2",
        xs: "h-6 gap-1 rounded-[min(var(--radius-md),10px)] px-2 text-xs in-data-[slot=button-group]:rounded-lg has-data-[icon=inline-end]:pr-1.5 has-data-[icon=inline-start]:pl-1.5 [&_svg:not([class*='size-'])]:size-3",
        sm: "h-7 gap-1 rounded-[min(var(--radius-md),12px)] px-2.5 text-app-detail in-data-[slot=button-group]:rounded-lg has-data-[icon=inline-end]:pr-1.5 has-data-[icon=inline-start]:pl-1.5 [&_svg:not([class*='size-'])]:size-3.5",
        lg: "h-9 gap-1.5 px-2.5 has-data-[icon=inline-end]:pr-3 has-data-[icon=inline-start]:pl-3",
        icon: "size-8",
        "icon-xs": "size-6 rounded-[min(var(--radius-md),10px)] in-data-[slot=button-group]:rounded-lg [&_svg:not([class*='size-'])]:size-3",
        "icon-sm": "size-7 rounded-[min(var(--radius-md),12px)] in-data-[slot=button-group]:rounded-lg",
        "icon-lg": "size-9",
        // App sizes (no fixed height — padding-driven like existing header buttons)
        "app-sm": "px-2 py-0.5 text-app-caption gap-1 [&_svg:not([class*='size-'])]:size-3",
        "app-md": "px-3 py-1.5 text-xs gap-1.5",
        "app-lg": "px-4 py-2 text-sm gap-1.5",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  },
);

function Button({ className, variant = "default", size = "default", type = "button", ...props }: ButtonPrimitive.Props & VariantProps<typeof buttonVariants>) {
  return <ButtonPrimitive data-slot="button" className={cn(buttonVariants({ variant, size, className }))} type={type} {...props} />;
}

export { Button, buttonVariants };
