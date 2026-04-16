import { MapWorkspace } from "@/components/map/map-workspace";

export const dynamic = "force-dynamic";

export default function MapPage() {
  return (
    <div className="flex h-screen w-screen overflow-hidden">
      <MapWorkspace />
    </div>
  );
}
