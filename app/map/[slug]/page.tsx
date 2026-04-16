import { notFound, redirect } from "next/navigation";
import { MapWorkspace } from "@/components/map/map-workspace";
import { supabaseServer } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

type Props = { params: Promise<{ slug: string }> };

export default async function ScopedMapPage({ params }: Props) {
  const { slug } = await params;
  const supabase = await supabaseServer();
  const { data: userData } = await supabase.auth.getUser();
  if (!userData.user) {
    redirect(`/login?next=/map/${encodeURIComponent(slug)}`);
  }

  const { data: project, error } = await supabase
    .schema("opengeo")
    .from("projects")
    .select("id, slug, name")
    .eq("slug", slug)
    .maybeSingle();

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
