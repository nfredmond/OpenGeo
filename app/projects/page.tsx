import Link from "next/link";
import { redirect } from "next/navigation";
import { supabaseServer } from "@/lib/supabase/server";
import { NewProjectForm } from "./new-project-form";

export const dynamic = "force-dynamic";

type ProjectRow = {
  id: string;
  slug: string;
  name: string;
  visibility: "private" | "org" | "public";
  created_at: string;
  updated_at: string;
  org: { id: string; slug: string; name: string; plan: string } | null;
  datasets: { id: string }[] | null;
  drone_flights: { id: string }[] | null;
};

export default async function ProjectsPage() {
  const supabase = await supabaseServer();
  const { data: userData } = await supabase.auth.getUser();
  if (!userData.user) {
    redirect("/login?next=/projects");
  }

  const { data, error } = await supabase
    .schema("opengeo")
    .from("projects")
    .select(
      `
      id,
      slug,
      name,
      visibility,
      created_at,
      updated_at,
      org:orgs!inner (id, slug, name, plan),
      datasets (id),
      drone_flights (id)
    `,
    )
    .order("updated_at", { ascending: false })
    .returns<ProjectRow[]>();

  const projects = data ?? [];

  return (
    <div className="min-h-screen bg-[color:var(--background)]">
      <header className="border-b border-[color:var(--border)] bg-[color:var(--card)]">
        <div className="mx-auto flex max-w-5xl items-center justify-between px-6 py-5">
          <div>
            <Link href="/" className="text-sm font-semibold tracking-tight">
              OpenGeo
            </Link>
            <nav className="mt-1 flex items-center gap-4 text-xs text-[color:var(--muted)]">
              <Link href="/projects" className="text-[color:var(--foreground)]">
                Projects
              </Link>
              <Link href="/map" className="hover:text-[color:var(--foreground)]">
                Map
              </Link>
              <Link href="/status" className="hover:text-[color:var(--foreground)]">
                Status
              </Link>
            </nav>
          </div>
          <form action="/api/auth/signout" method="post" className="flex items-center gap-3">
            <span className="text-[10px] text-[color:var(--muted)]" title={userData.user.email ?? undefined}>
              {userData.user.email}
            </span>
            <button
              type="submit"
              className="rounded border border-[color:var(--border)] px-2 py-1 text-[10px] font-medium text-[color:var(--muted)] hover:bg-[color:var(--border)] hover:text-[color:var(--foreground)]"
            >
              Sign out
            </button>
          </form>
        </div>
      </header>

      <main className="mx-auto max-w-5xl px-6 py-8">
        <section className="mb-8 grid gap-6 md:grid-cols-[2fr_1fr]">
          <div>
            <h1 className="text-xl font-semibold tracking-tight">Projects</h1>
            <p className="mt-1 text-sm text-[color:var(--muted)]">
              Each project groups datasets, flights, and layers. Every org
              starts with a <span className="font-mono">default</span> project.
            </p>
          </div>
          <NewProjectForm />
        </section>

        {error ? (
          <div className="rounded-md border border-red-500/40 bg-red-500/10 p-4 text-sm text-red-600">
            {error.message}
          </div>
        ) : projects.length === 0 ? (
          <div className="rounded-md border border-[color:var(--border)] bg-[color:var(--card)] p-6 text-sm text-[color:var(--muted)]">
            No projects yet. Create one on the right.
          </div>
        ) : (
          <ul className="grid gap-3 md:grid-cols-2">
            {projects.map((p) => {
              const org = p.org;
              return (
                <li
                  key={p.id}
                  className="rounded-md border border-[color:var(--border)] bg-[color:var(--card)] p-4 transition hover:border-[color:var(--accent)]"
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <h2 className="truncate text-sm font-semibold">{p.name}</h2>
                      {org && (
                        <p className="truncate text-[11px] text-[color:var(--muted)]">
                          {org.name} · {org.plan}
                        </p>
                      )}
                    </div>
                    <span className="rounded bg-[color:var(--background)] px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider text-[color:var(--muted)]">
                      {p.visibility}
                    </span>
                  </div>
                  <div className="mt-3 flex gap-4 text-xs text-[color:var(--muted)]">
                    <span>
                      <span className="font-semibold text-[color:var(--foreground)]">
                        {p.datasets?.length ?? 0}
                      </span>{" "}
                      datasets
                    </span>
                    <span>
                      <span className="font-semibold text-[color:var(--foreground)]">
                        {p.drone_flights?.length ?? 0}
                      </span>{" "}
                      flights
                    </span>
                  </div>
                  <div className="mt-3 flex items-center justify-between text-[11px] text-[color:var(--muted)]">
                    <code className="font-mono">{p.slug}</code>
                    <Link
                      href={`/map/${p.slug}`}
                      className="text-[color:var(--accent)] hover:underline"
                    >
                      Open map →
                    </Link>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </main>
    </div>
  );
}
