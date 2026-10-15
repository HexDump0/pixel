/** Menus, dialogs and tooltips: thin, styled wrappers over Radix primitives. */
import * as DM from "@radix-ui/react-dropdown-menu";
import * as D from "@radix-ui/react-dialog";
import * as T from "@radix-ui/react-tooltip";
import { IconCheck } from "@tabler/icons-react";
import type { ReactNode } from "react";
import { cn } from "../../lib/cn.ts";
import { IC_SM } from "./bits.tsx";

// ---- menu ----

export interface MenuItem {
  label: ReactNode;
  icon?: ReactNode;
  hint?: ReactNode;
  onSelect?: () => void;
  disabled?: boolean;
  danger?: boolean;
  checked?: boolean;
}
export type MenuEntry = MenuItem | "-" | { head: ReactNode } | null | false;

const itemClass =
  "grid h-[34px] w-full cursor-pointer grid-cols-[16px_1fr_auto] items-center gap-2 rounded-md px-2 text-left text-[13.5px] text-ink outline-none select-none data-[disabled]:cursor-default data-[disabled]:opacity-45 data-[highlighted]:bg-s3 [&>svg]:text-ink-3";

/** A dropdown menu from a list of entries ("-" is a separator, {head} a group label). */
export function Menu({ trigger, items, align = "end", className }: { trigger: ReactNode; items: MenuEntry[]; align?: "start" | "end" | "center"; className?: string }) {
  return (
    <DM.Root modal={false}>
      <DM.Trigger asChild>{trigger}</DM.Trigger>
      <DM.Portal>
        <DM.Content
          align={align}
          sideOffset={6}
          collisionPadding={12}
          onClick={(e) => e.stopPropagation()}
          className={cn("z-[880] max-h-[70vh] min-w-60 overflow-y-auto rounded-xl border border-line bg-s2 p-1.5 shadow-pop", className)}
        >
          {items.map((it, i) => {
            if (!it) return null;
            if (it === "-") return <DM.Separator key={i} className="my-1 h-px bg-line-2" />;
            if ("head" in it) return <DM.Label key={i} className="px-2.5 pt-1.5 pb-1 pl-8 text-xs text-ink-3">{it.head}</DM.Label>;
            return (
              <DM.Item key={i} disabled={it.disabled} onSelect={it.onSelect} className={cn(itemClass, it.danger && "text-critical [&>svg]:text-critical")}>
                {it.checked ? <IconCheck {...IC_SM} className="text-accent" /> : (it.icon ?? <span />)}
                <span className="truncate">{it.label}</span>
                {it.hint ? <span className="max-w-48 truncate font-mono text-xs text-ink-3">{it.hint}</span> : <span />}
              </DM.Item>
            );
          })}
        </DM.Content>
      </DM.Portal>
    </DM.Root>
  );
}

// ---- dialog ----

export function Dialog({
  open,
  onOpenChange,
  title,
  hideTitle,
  children,
  className,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  /** Keep the title for screen readers only (the content has its own heading). */
  hideTitle?: boolean;
  children: ReactNode;
  className?: string;
}) {
  return (
    <D.Root open={open} onOpenChange={onOpenChange}>
      <D.Portal>
        <D.Overlay className="fixed inset-0 z-[850] bg-black/55" />
        <D.Content
          aria-describedby={undefined}
          onOpenAutoFocus={(e) => {
            // focus the first field, not the close button
            const el = (e.currentTarget as HTMLElement).querySelector<HTMLElement>("textarea, input, [data-autofocus]");
            if (el) {
              e.preventDefault();
              el.focus();
            }
          }}
          className={cn(
            "fixed top-[10vh] left-1/2 z-[851] max-h-[84vh] w-[min(820px,calc(100vw-32px))] -translate-x-1/2 overflow-y-auto rounded-2xl border border-line bg-s1 p-6 shadow-pop outline-none",
            className,
          )}
        >
          <D.Title className={hideTitle ? "sr-only" : "m-0 mb-4 text-lg font-medium"}>{title}</D.Title>
          {children}
        </D.Content>
      </D.Portal>
    </D.Root>
  );
}
export const DialogClose = D.Close;

// ---- tooltip ----

export const TipProvider = ({ children }: { children: ReactNode }) => (
  <T.Provider delayDuration={300} skipDelayDuration={200}>
    {children}
  </T.Provider>
);

/** Hover/focus tooltip for the long form of something short. */
export function Tip({ content, children, side = "top" }: { content: ReactNode; children: ReactNode; side?: "top" | "bottom" | "left" | "right" }) {
  if (!content) return <>{children}</>;
  return (
    <T.Root>
      <T.Trigger asChild>{children}</T.Trigger>
      <T.Portal>
        <T.Content side={side} sideOffset={6} collisionPadding={8} className="z-[950] max-w-[300px] rounded-lg border border-line bg-s3 px-2.5 py-2 text-[12.5px] leading-snug text-ink shadow-pop">
          {content}
        </T.Content>
      </T.Portal>
    </T.Root>
  );
}
