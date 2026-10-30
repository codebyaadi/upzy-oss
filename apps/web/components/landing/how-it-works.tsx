const steps = [
  {
    n: "01",
    title: "Add what you run",
    body: "Paste a URL or a domain. Upzy starts checking and finds the subdomains you forgot about.",
  },
  {
    n: "02",
    title: "We watch and scan",
    body: "Uptime checks run continuously. Security checks look at what any visitor on the internet can see.",
  },
  {
    n: "03",
    title: "Get the why, not just the alert",
    body: "Every finding arrives with the fix for your stack. Connect your own AI key and incidents and findings get a plain-English explanation too.",
  },
];

export function HowItWorks() {
  return (
    <section id="how-it-works" className="px-4 py-24">
      <div className="bg-primary text-primary-foreground mx-auto max-w-5xl rounded-[2rem] p-8 sm:p-14">
        <p className="text-sm font-semibold opacity-70">How it works</p>
        <h2 className="mt-3 max-w-xl text-4xl font-extrabold tracking-tighter text-balance sm:text-5xl">
          From URL to answers in three steps.
        </h2>
        <ol className="mt-12 grid gap-10 sm:grid-cols-3">
          {steps.map((s) => (
            <li key={s.n}>
              <span className="text-5xl font-extrabold tracking-tighter opacity-30">{s.n}</span>
              <h3 className="mt-4 text-xl font-bold tracking-tight">{s.title}</h3>
              <p className="mt-2 leading-relaxed opacity-80">{s.body}</p>
            </li>
          ))}
        </ol>
      </div>
    </section>
  );
}
