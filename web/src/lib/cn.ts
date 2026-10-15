import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

/** Join class names; later Tailwind utilities win over earlier ones (`cn("px-2", big && "px-4")`). */
export const cn = (...c: ClassValue[]) => twMerge(clsx(c));
