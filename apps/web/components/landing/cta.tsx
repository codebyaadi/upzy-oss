import { PrimaryCta } from "@/components/auth-aware";

export function Cta() {
  return (
    <section id="early-access" className="px-4 py-24">
      <div className="bg-card/70 mx-auto max-w-5xl rounded-[2rem] border p-8 text-center shadow-[var(--shadow-panel)] backdrop-blur-xl sm:p-14">
        <h2 className="mx-auto max-w-2xl text-4xl font-extrabold tracking-tighter text-balance sm:text-5xl">
          Start watching with <span className="text-brand">Upzy</span>.
        </h2>
        <p className="text-muted-foreground mx-auto mt-4 max-w-xl text-lg leading-relaxed text-pretty">
          Create a free account, add your first monitor and get alerted in minutes.
        </p>
        <PrimaryCta size="lg" className="mt-8" />
      </div>
    </section>
  );
}
