/** Menus, selects, dialogs, sheets, popovers and tooltips: thin, styled wrappers over Radix primitives. */
import * as DM from "@radix-ui/react-dropdown-menu";
import * as D from "@radix-ui/react-dialog";
import * as T from "@radix-ui/react-tooltip";
import * as P from "@radix-ui/react-popover";
import { IconArrowLeft, IconCheck, IconChevronDown, IconChevronRight, IconX } from "@tabler/icons-react";
import type { ReactNode } from "react";
import { cn } from "../../lib/cn.ts";
import { IC_SM, IC_XS } from "./bits.tsx";

// ---- menu ----

export interface MenuItem {
  label: ReactNode;
  icon?: ReactNode;
  hint?: ReactNode;
  onSelect?: () => void;
  disabled?: boolean;
  danger?: boolean;
  checked?: boolean;
  /** Opens a submenu with these entries. Called while the submenu renders, so it may use hooks (data loads when it opens). */
  sub?: () => MenuEntry[];
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
          className={cn(menuPanel, className)}
        >
          <MenuEntries items={items} />
        </DM.Content>
      </DM.Portal>
    </DM.Root>
  );
}

const menuPanel = "z-[880] max-h-[70vh] min-w-60 overflow-y-auto rounded-xl border border-line bg-s2 p-1.5 shadow-pop";

function MenuEntries({ items }: { items: MenuEntry[] }) {
  return (
    <>
      {items.map((it, i) => {
        if (!it) return null;
        if (it === "-") return <DM.Separator key={i} className="my-1 h-px bg-line-2" />;
        if ("head" in it) return <DM.Label key={i} className="px-2.5 pt-1.5 pb-1 pl-8 text-xs text-ink-3">{it.head}</DM.Label>;
        const lead = it.checked ? <IconCheck {...IC_SM} className="text-accent" /> : (it.icon ?? <span />);
        const hint = it.hint ? <span className="max-w-48 truncate font-mono text-xs text-ink-3">{it.hint}</span> : null;
        if (it.sub)
          return (
            <DM.Sub key={i}>
              <DM.SubTrigger disabled={it.disabled} className={cn(itemClass, "grid-cols-[16px_1fr_auto_auto] data-[state=open]:bg-s3")}>
                {lead}
                <span className="truncate">{it.label}</span>
                {hint ?? <span />}
                <IconChevronRight {...IC_XS} className="text-ink-3" />
              </DM.SubTrigger>
              <DM.Portal>
                <DM.SubContent sideOffset={6} alignOffset={-6} collisionPadding={12} onClick={(e) => e.stopPropagation()} className={menuPanel}>
                  <SubEntries get={it.sub} />
                </DM.SubContent>
              </DM.Portal>
            </DM.Sub>
          );
        return (
          <DM.Item key={i} disabled={it.disabled} onSelect={it.onSelect} className={cn(itemClass, it.danger && "text-critical [&>svg]:text-critical")}>
            {lead}
            <span className="truncate">{it.label}</span>
            {hint ?? <span />}
          </DM.Item>
        );
      })}
    </>
  );
}

const SubEntries = ({ get }: { get: () => MenuEntry[] }) => <MenuEntries items={get()} />;

// ---- select ----

export type SelectOption = [value: string, label: ReactNode] | { value: string; label: ReactNode; hint?: ReactNode };

/**
 * A single-choice picker in place of a native <select>: the trigger shows the chosen label, the list
 * opens as one of our menus with a check on the current value. `field` makes it look like an .input.
 */
export function Select({
  value,
  onChange,
  options,
  label,
  icon,
  field,
  className,
}: {
  value: string;
  onChange: (v: string) => void;
  options: SelectOption[];
  /** Accessible name when no visible label says what it is. */
  label?: string;
  icon?: ReactNode;
  field?: boolean;
  className?: string;
}) {
  const opts = options.map((o) => (Array.isArray(o) ? { value: o[0], label: o[1], hint: undefined } : o));
  const current = opts.find((o) => o.value === value);
  return (
    <DM.Root modal={false}>
      <DM.Trigger
        aria-label={label}
        className={cn(
          "group inline-flex min-w-0 cursor-pointer items-center gap-2 text-left outline-none",
          field
            ? "input w-full"
            : "h-[34px] rounded-[10px] border border-line-2 bg-s1 pr-2.5 pl-2.5 text-[13px] text-ink-2 hover:border-line focus-visible:border-accent data-[state=open]:border-line [&>svg:first-child]:text-ink-3",
          className,
        )}
      >
        {icon}
        <span className="min-w-0 flex-1 truncate">{current?.label ?? value}</span>
        <IconChevronDown {...IC_XS} className="shrink-0 text-ink-3 transition-transform group-data-[state=open]:rotate-180" />
      </DM.Trigger>
      <DM.Portal>
        <DM.Content
          align="start"
          sideOffset={6}
          collisionPadding={12}
          className="z-[880] max-h-[min(70vh,var(--radix-dropdown-menu-content-available-height))] min-w-[max(var(--radix-dropdown-menu-trigger-width),10rem)] overflow-y-auto rounded-xl border border-line bg-s2 p-1.5 shadow-pop"
        >
          <DM.RadioGroup value={value} onValueChange={onChange}>
            {opts.map((o) => (
              <DM.RadioItem key={o.value} value={o.value} className={itemClass}>
                <DM.ItemIndicator asChild>
                  <IconCheck {...IC_SM} className="text-accent" />
                </DM.ItemIndicator>
                <span className="col-start-2 truncate">{o.label}</span>
                {o.hint ? <span className="max-w-48 truncate font-mono text-xs text-ink-3">{o.hint}</span> : <span />}
              </DM.RadioItem>
            ))}
          </DM.RadioGroup>
        </DM.Content>
      </DM.Portal>
    </DM.Root>
  );
}

// ---- dialog ----

const DIALOG_W = { sm: "w-[min(440px,calc(100vw-32px))]", md: "w-[min(580px,calc(100vw-32px))]", lg: "w-[min(820px,calc(100vw-32px))]" };

/** Focus the first field, not the close button. */
const focusFirstField = (e: Event) => {
  const el = (e.currentTarget as HTMLElement).querySelector<HTMLElement>("[data-autofocus], textarea:not([disabled]), input:not([disabled]):not([type=checkbox]):not([type=radio])");
  if (el) {
    e.preventDefault();
    el.focus();
  }
};

/**
 * A centred modal: header (optional back arrow, title, one line of description, close), a body that
 * scrolls, and a footer bar for the actions.
 */
export function Dialog({
  open = true,
  onOpenChange,
  title,
  description,
  hideTitle,
  back,
  footer,
  size = "lg",
  children,
  className,
  bodyClassName,
}: {
  open?: boolean;
  onOpenChange: (open: boolean) => void;
  title: ReactNode;
  description?: ReactNode;
  /** Keep the title for screen readers only (the content has its own heading); no header bar. */
  hideTitle?: boolean;
  /** Shows a back arrow before the title (multi-step dialogs). */
  back?: () => void;
  footer?: ReactNode;
  size?: keyof typeof DIALOG_W;
  children: ReactNode;
  className?: string;
  bodyClassName?: string;
}) {
  return (
    <D.Root open={open} onOpenChange={onOpenChange}>
      <D.Portal>
        <D.Overlay className="fixed inset-0 z-[850] bg-[var(--scrim)]" />
        <D.Content
          aria-describedby={undefined}
          onOpenAutoFocus={focusFirstField}
          className={cn("fixed top-[9vh] left-1/2 z-[851] flex max-h-[84vh] -translate-x-1/2 flex-col overflow-hidden rounded-2xl border border-line bg-s1 shadow-pop outline-none", DIALOG_W[size], className)}
        >
          {hideTitle ? (
            <D.Title className="sr-only">{title}</D.Title>
          ) : (
            <header className="flex shrink-0 items-start gap-2 px-5 pt-4 pb-3">
              {back && (
                <button type="button" onClick={back} aria-label="Back" className="-ml-1.5 inline-flex size-7 cursor-pointer items-center justify-center rounded-md text-ink-3 hover:bg-s3 hover:text-ink">
                  <IconArrowLeft {...IC_SM} />
                </button>
              )}
              <div className="min-w-0 flex-1 pt-[3px]">
                <D.Title className="m-0 text-[15px] leading-snug font-medium">{title}</D.Title>
                {description && <div className="mt-1 text-[13px] text-ink-3">{description}</div>}
              </div>
              <D.Close aria-label="Close" className="-mr-1.5 inline-flex size-7 shrink-0 cursor-pointer items-center justify-center rounded-md text-ink-3 hover:bg-s3 hover:text-ink">
                <IconX {...IC_SM} />
              </D.Close>
            </header>
          )}
          <div className={cn("flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-5 pb-5", hideTitle && "pt-5", bodyClassName)}>{children}</div>
          {footer && <footer className="flex shrink-0 flex-wrap items-center justify-end gap-1.5 border-t border-line-2 px-5 py-3">{footer}</footer>}
        </D.Content>
      </D.Portal>
    </D.Root>
  );
}
export const DialogClose = D.Close;

/** A full-height panel from the right edge, for work that sits beside the page (the live test). */
export function Sheet({ open = true, onOpenChange, title, children, className }: { open?: boolean; onOpenChange: (open: boolean) => void; title: string; children: ReactNode; className?: string }) {
  return (
    <D.Root open={open} onOpenChange={onOpenChange}>
      <D.Portal>
        <D.Overlay className="fixed inset-0 z-[850] bg-[var(--scrim)]" />
        <D.Content
          aria-describedby={undefined}
          onOpenAutoFocus={focusFirstField}
          className={cn("fixed inset-y-0 right-0 z-[851] flex w-[min(760px,100vw)] flex-col border-l border-line bg-s1 shadow-pop outline-none", className)}
        >
          <D.Title className="sr-only">{title}</D.Title>
          {children}
        </D.Content>
      </D.Portal>
    </D.Root>
  );
}

// ---- popover ----

/** Content anchored to a trigger (pickers with a search box, small forms). */
export function Popover({
  trigger,
  children,
  open,
  onOpenChange,
  align = "start",
  className,
}: {
  trigger: ReactNode;
  children: ReactNode;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  align?: "start" | "center" | "end";
  className?: string;
}) {
  return (
    <P.Root open={open} onOpenChange={onOpenChange}>
      <P.Trigger asChild>{trigger}</P.Trigger>
      <P.Portal>
        <P.Content
          align={align}
          sideOffset={6}
          collisionPadding={12}
          className={cn("z-[900] max-h-[var(--radix-popover-content-available-height)] overflow-hidden rounded-xl border border-line bg-s2 shadow-pop outline-none", className)}
        >
          {children}
        </P.Content>
      </P.Portal>
    </P.Root>
  );
}

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
