export function Section({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <section className={`py-16 ${className || ""}`}>
      {children}
    </section>
  );
}