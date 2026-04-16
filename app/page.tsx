import Link from "next/link";

export default function Home() {
  return (
    <main className="mx-auto flex min-h-screen max-w-5xl flex-col gap-12 px-6 py-16">
      <header className="flex flex-col gap-3">
        <span className="text-xs font-medium uppercase tracking-widest text-[color:var(--muted)]">
          OpenGeo · v0.0.1 · Phase 1 scaffold
        </span>
        <h1 className="text-4xl font-semibold tracking-tight sm:text-5xl">
          Drone-to-insight geospatial platform.
        </h1>
        <p className="max-w-2xl text-base text-[color:var(--muted)] sm:text-lg">
          Upload drone imagery, let AI extract features, and query the map with
          plain English. Built on PostGIS, MapLibre, OpenDroneMap, and Claude —
          AGPL open core, hosted or self-hosted.
        </p>
      </header>

      <section className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Card
          title="Projects"
          href="/projects"
          description="Group datasets, flights, and layers by planning project."
        />
        <Card
          title="Map viewer"
          href="/map"
          description="Browse and edit vector + raster layers on a MapLibre map."
        />
        <Card
          title="Upload data"
          href="/map"
          description="Drop a GeoJSON file to stream it into PostGIS as a layer."
        />
        <Card
          title="Ask a question"
          href="/map"
          description="Natural language → PostGIS query, results on the map."
        />
      </section>

      <section className="rounded-lg border border-[color:var(--border)] bg-[color:var(--card)] p-6">
        <h2 className="text-lg font-semibold">Status</h2>
        <p className="mt-2 text-sm text-[color:var(--muted)]">
          Scaffolding complete. Core migrations for PostGIS + pgvector + RLS
          are in <code className="font-mono text-xs">supabase/migrations/</code>.
          Local stack (Postgres, Martin, TiTiler, pg_featureserv) runs via
          <code className="mx-1 font-mono text-xs">docker compose up -d</code>.
        </p>
      </section>

      <footer className="mt-auto text-xs text-[color:var(--muted)]">
        © 2026 Nathaniel Ford Redmond / Nat Ford Planning · AGPL-3.0-or-later
      </footer>
    </main>
  );
}

function Card({
  title,
  description,
  href,
}: {
  title: string;
  description: string;
  href: string;
}) {
  return (
    <Link
      href={href}
      className="group rounded-lg border border-[color:var(--border)] bg-[color:var(--card)] p-5 transition hover:border-[color:var(--accent)]"
    >
      <h3 className="text-base font-semibold group-hover:text-[color:var(--accent)]">
        {title}
      </h3>
      <p className="mt-2 text-sm text-[color:var(--muted)]">{description}</p>
    </Link>
  );
}
