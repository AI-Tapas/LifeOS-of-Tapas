// Entering a screen should feel like a page settling, not a hard cut. App
// Router remounts a template on every navigation and leaves it alone on a data
// refresh, so the ease plays once per route change and never while a list
// updates in place.
//
// This div wraps the page content only. The bottom nav, the quick-add button
// and the re-auth banner are its SIBLINGS in app/(app)/layout.tsx, not its
// children: a transform on an ancestor of a position: fixed element makes that
// element scroll with the page, which is exactly the bug this app already
// fixed once. Do not move the nav inside here.
export default function AppTemplate({
  children,
}: {
  children: React.ReactNode;
}) {
  return <div className="page-in">{children}</div>;
}
