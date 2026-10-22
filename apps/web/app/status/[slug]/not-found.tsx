import Link from "next/link";

export default function NotFound() {
  return (
    <div className="ambient grid min-h-svh place-items-center px-4">
      <div className="max-w-sm text-center">
        <h1 className="text-2xl font-extrabold tracking-tighter">No status page here</h1>
        <p className="text-muted-foreground mt-2 text-sm">
          This address doesn&rsquo;t exist, or its owner hasn&rsquo;t published it yet.
        </p>
        <Link
          href="/"
          className="mt-4 inline-block text-sm font-semibold underline underline-offset-4"
        >
          Go to Upzy
        </Link>
      </div>
    </div>
  );
}
