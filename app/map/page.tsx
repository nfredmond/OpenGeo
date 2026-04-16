import { redirect } from "next/navigation";
import { MapWorkspace } from "@/components/map/map-workspace";
import { supabaseServer } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

export default async function MapPage() {
  const supabase = await supabaseServer();
  const { data } = await supabase.auth.getUser();
  if (!data.user) {
    redirect("/login?next=/map");
  }

  return (
    <div className="flex h-screen w-screen overflow-hidden">
      <MapWorkspace userEmail={data.user.email ?? null} />
    </div>
  );
}
