import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { supabaseServer } from "@/lib/supabase/server";
import { SharePanel } from "./share-panel";

export const dynamic = "force-dynamic";

export default async function ProjectSharePage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ projectId?: string | string[] }>;
}) {
  const { slug } = await params;
  const rawSearchParams = await searchParams;
  const rawProjectId = rawSearchParams.projectId;
  const projectId = Array.isArray(rawProjectId) ? rawProjectId[0] : rawProjectId;
  const supabase = await supabaseServer();
  const { data: userData } = await supabase.auth.getUser();
  if (!userData.user) {
    const next = projectId
      ? `/projects/${slug}/share?projectId=${encodeURIComponent(projectId)}`
      : `/projects/${slug}/share`;
    redirect(`/login?next=${encodeURIComponent(next)}`);
  }

  const query = supabase
    .schema("opengeo")
    .from("projects")
    .select("id, slug, name, visibility");

  let project: { id: string; slug: string; name: string; visibility: string } | null = null;
  let error: { message: string } | null = null;
  if (projectId) {
    const result = await query.eq("id", projectId).eq("slug", slug).maybeSingle();
    project = result.data;
    error = result.error;
  } else {
    const result = await query.eq("slug", slug).limit(2);
    const rows = result.data ?? [];
    error = result.error;
    if (!error && rows.length > 1) {
      error = { message: "Project slug is ambiguous. Open the project from the Projects list." };
    }
    project = rows[0] ?? null;
  }

  if (error) {
    return (
      <div className="min-h-screen bg-[color:var(--background)] px-6 py-10">
        <div className="mx-auto max-w-3xl rounded-md border border-red-500/40 bg-red-500/10 p-4 text-sm text-red-600">
          {error.message}
        </div>
      </div>
    );
  }
  if (!project) notFound();

  return (
    <div className="min-h-screen bg-[color:var(--background)]">
      <header className="border-b border-[color:var(--border)] bg-[color:var(--card)]">
        <div className="mx-auto flex max-w-3xl items-center justify-between px-6 py-5">
          <div>
            <Link href="/" className="text-sm font-semibold tracking-tight">
              OpenGeo
            </Link>
            <nav className="mt-1 flex items-center gap-4 text-xs text-[color:var(--muted)]">
              <Link href="/projects" className="hover:text-[color:var(--foreground)]">
                ← Projects
              </Link>
              <Link
                href={`/map/${project.slug}`}
                className="hover:text-[color:var(--foreground)]"
              >
                Map
              </Link>
              <span className="text-[color:var(--foreground)]">Share</span>
            </nav>
          </div>
          <span className="text-[10px] text-[color:var(--muted)]">
            {userData.user.email}
          </span>
        </div>
      </header>

      <main className="mx-auto max-w-3xl px-6 py-8">
        <section className="mb-6">
          <h1 className="text-xl font-semibold tracking-tight">
            Share · {project.name}
          </h1>
          <p className="mt-1 text-sm text-[color:var(--muted)]">
            Invite collaborators to this specific project. Invitees don&apos;t
            need an account yet — they&apos;ll get a magic-link email and land
            here with view or edit access after signing in.
          </p>
        </section>

        <SharePanel projectSlug={project.slug} projectId={project.id} />
      </main>
    </div>
  );
}
