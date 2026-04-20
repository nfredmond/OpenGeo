import { notFound, redirect } from "next/navigation";
import { MapWorkspace } from "@/components/map/map-workspace";
import { supabaseServer } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

type Props = {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ projectId?: string | string[] }>;
};

export default async function ScopedMapPage({ params, searchParams }: Props) {
  const { slug } = await params;
  const rawSearchParams = await searchParams;
  const rawProjectId = rawSearchParams.projectId;
  const projectId = Array.isArray(rawProjectId) ? rawProjectId[0] : rawProjectId;
  const supabase = await supabaseServer();
  const { data: userData } = await supabase.auth.getUser();
  if (!userData.user) {
    const next = projectId
      ? `/map/${encodeURIComponent(slug)}?projectId=${encodeURIComponent(projectId)}`
      : `/map/${encodeURIComponent(slug)}`;
    redirect(`/login?next=${encodeURIComponent(next)}`);
  }

  const query = supabase
    .schema("opengeo")
    .from("projects")
    .select("id, slug, name");

  let project: { id: string; slug: string; name: string } | null = null;
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
      <div className="grid h-screen place-items-center p-8 text-sm text-red-500">
        {error.message}
      </div>
    );
  }
  if (!project) notFound();

  return (
    <div className="flex h-screen w-screen overflow-hidden">
      <MapWorkspace
        userEmail={userData.user.email ?? null}
        project={{ id: project.id, slug: project.slug, name: project.name }}
      />
    </div>
  );
}
