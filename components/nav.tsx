"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const items = [
  { href: "/", label: "Dashboard" },
  { href: "/calendar", label: "Calendar" },
  { href: "/tasks", label: "Tasks" },
  { href: "/trips", label: "Trips" },
  { href: "/brain", label: "Brain" },
  { href: "/money", label: "Money" },
  { href: "/assistant", label: "Assistant" },
  { href: "/settings", label: "Settings" },
];

export default function Nav() {
  const pathname = usePathname();

  return (
    <nav className="fixed inset-x-0 bottom-0 border-t border-neutral-200 bg-white/95 backdrop-blur dark:border-neutral-800 dark:bg-neutral-950/95">
      <div className="mx-auto flex max-w-3xl gap-1 overflow-x-auto px-2 py-2">
        {items.map((item) => {
          const active = pathname === item.href;
          return (
            <Link
              key={item.href}
              href={item.href}
              className={
                "shrink-0 rounded-full px-3 py-1.5 text-sm " +
                (active
                  ? "bg-indigo-600 text-white"
                  : "text-neutral-600 dark:text-neutral-300")
              }
            >
              {item.label}
            </Link>
          );
        })}
      </div>
    </nav>
  );
}
