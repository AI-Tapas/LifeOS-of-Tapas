import Nav from "@/components/nav";

export default function AppLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className="mx-auto min-h-dvh max-w-3xl px-4 pb-20 pt-6">
      {children}
      <Nav />
    </div>
  );
}
