"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

// Bottom navigation. Every destination is visible: a "More" sheet saved a row
// of height but cost a tap and, worse, hid half the app behind a guess. On a
// phone the eight sit as two rows of four; from small screens up they fit on
// one row.

type Item = { href: string; label: string; icon: React.ReactNode };

const stroke = {
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.8,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
};

const icons = {
  home: (
    <svg viewBox="0 0 24 24" className="h-6 w-6" {...stroke}>
      <path d="M3 10.5 12 3l9 7.5" />
      <path d="M5 9.5V21h5v-6h4v6h5V9.5" />
    </svg>
  ),
  calendar: (
    <svg viewBox="0 0 24 24" className="h-6 w-6" {...stroke}>
      <rect x="3" y="5" width="18" height="16" rx="2" />
      <path d="M3 10h18M8 3v4M16 3v4" />
    </svg>
  ),
  tasks: (
    <svg viewBox="0 0 24 24" className="h-6 w-6" {...stroke}>
      <circle cx="12" cy="12" r="9" />
      <path d="m8.5 12.5 2.5 2.5 5-5.5" />
    </svg>
  ),
  money: (
    <svg viewBox="0 0 24 24" className="h-6 w-6" {...stroke}>
      <rect x="2.5" y="6" width="19" height="12" rx="2" />
      <circle cx="12" cy="12" r="2.8" />
      <path d="M6 9.5v.01M18 14.5v.01" />
    </svg>
  ),
  trips: (
    <svg viewBox="0 0 24 24" className="h-6 w-6" {...stroke}>
      <path d="M2.5 19h19" />
      <path d="m4 15 16.5-4.5a1.8 1.8 0 0 0-1-3.5L14 8.5 7 5 5 6l4 4-4.5 1.5-2-1.5-1.5.5z" />
    </svg>
  ),
  brain: (
    <svg viewBox="0 0 24 24" className="h-6 w-6" {...stroke}>
      <path d="M12 4a3.5 3.5 0 0 0-3.5 3.5c-2 .3-3.5 2-3.5 4a4 4 0 0 0 2.5 3.7A3.5 3.5 0 0 0 11 20h1z" />
      <path d="M12 4a3.5 3.5 0 0 1 3.5 3.5c2 .3 3.5 2 3.5 4a4 4 0 0 1-2.5 3.7A3.5 3.5 0 0 1 13 20h-1z" />
    </svg>
  ),
  assistant: (
    <svg viewBox="0 0 24 24" className="h-6 w-6" {...stroke}>
      <path d="M12 3v2M5 8a7 7 0 0 1 14 0v5a7 7 0 0 1-14 0z" />
      <path d="M9 12h.01M15 12h.01" />
    </svg>
  ),
  settings: (
    <svg viewBox="0 0 24 24" className="h-6 w-6" {...stroke}>
      <circle cx="12" cy="12" r="3" />
      <path d="M19 12a7 7 0 0 0-.1-1.2l2-1.5-2-3.4-2.3 1a7 7 0 0 0-2-1.2L14.2 3h-4l-.4 2.5a7 7 0 0 0-2 1.2l-2.3-1-2 3.4 2 1.5a7.2 7.2 0 0 0 0 2.4l-2 1.5 2 3.4 2.3-1a7 7 0 0 0 2 1.2l.4 2.5h4l.4-2.5a7 7 0 0 0 2-1.2l2.3 1 2-3.4-2-1.5c.07-.4.1-.8.1-1.2z" />
    </svg>
  ),
};

const items: Item[] = [
  { href: "/", label: "Home", icon: icons.home },
  { href: "/calendar", label: "Calendar", icon: icons.calendar },
  { href: "/tasks", label: "Tasks", icon: icons.tasks },
  { href: "/money", label: "Money", icon: icons.money },
  { href: "/trips", label: "Trips", icon: icons.trips },
  { href: "/brain", label: "Brain", icon: icons.brain },
  { href: "/assistant", label: "Assistant", icon: icons.assistant },
  { href: "/settings", label: "Settings", icon: icons.settings },
];

export default function Nav() {
  const pathname = usePathname();

  return (
    <nav className="fixed inset-x-0 bottom-0 z-30 border-t border-neutral-200 bg-white/95 pb-[env(safe-area-inset-bottom)] backdrop-blur dark:border-neutral-800 dark:bg-neutral-950/95">
      <div className="mx-auto grid max-w-3xl grid-cols-4 sm:grid-cols-8">
        {items.map((item) => {
          const active = pathname === item.href;
          return (
            <Link
              key={item.href}
              href={item.href}
              aria-current={active ? "page" : undefined}
              className={
                "flex flex-col items-center gap-0.5 py-2 text-[10px] font-medium " +
                (active
                  ? "text-indigo-600 dark:text-indigo-400"
                  : "text-neutral-500 dark:text-neutral-400")
              }
            >
              {item.icon}
              {item.label}
            </Link>
          );
        })}
      </div>
    </nav>
  );
}
