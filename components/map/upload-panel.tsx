"use client";

import { Upload } from "lucide-react";
import { useCallback, useRef, useState } from "react";
import type { ClientLayer } from "./layer-panel";
import { pickColor } from "./colors";

export function UploadPanel({
  onLayerAdded,
  projectId,
}: {
  onLayerAdded: (layer: ClientLayer) => void;
  projectId?: string;
}) {
  const [dragging, setDragging] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const onFiles = useCallback(
    async (files: FileList | null) => {
      setError(null);
      if (!files || files.length === 0) return;
      const file = files[0];
      const lower = file.name.toLowerCase();
      const isGeoJson = lower.endsWith(".geojson") || lower.endsWith(".json");
      const isShapefileZip = lower.endsWith(".zip");
      if (!isGeoJson && !isShapefileZip) {
        setError("Supported formats: .geojson / .json, or a .zip containing a shapefile triad. GeoPackage ships in Phase 2.");
        return;
      }
      setUploading(true);
      try {
        const name = file.name.replace(/\.(geojson|json|zip)$/i, "");
        let body: { ok: boolean; layerId?: string; error?: string };
        let featureCount = 0;
        let clientFc: GeoJSON.FeatureCollection | null = null;

        if (isShapefileZip) {
          const form = new FormData();
          form.append("file", file);
          form.append("name", name);
          if (projectId) form.append("projectId", projectId);
          const response = await fetch("/api/datasets/upload", {
            method: "POST",
            body: form,
          });
          body = (await response.json().catch(() => ({}))) as {
            ok: boolean;
            layerId?: string;
            error?: string;
          };
          if (!response.ok || !body.ok || !body.layerId) {
            throw new Error(body.error ?? `Upload failed (${response.status}).`);
          }
          // Server decoded + reprojected the shapefile; fetch the finished
          // feature collection so the layer can render immediately without a
          // second user click.
          const detail = await fetch(`/api/layers/${body.layerId}`, {
            cache: "no-store",
          });
          if (detail.ok) {
            const d = (await detail.json().catch(() => ({}))) as {
              featureCollection?: GeoJSON.FeatureCollection;
              layer?: { feature_count?: number };
            };
            if (d.featureCollection) {
              clientFc = d.featureCollection;
              featureCount =
                d.layer?.feature_count ?? clientFc.features.length;
            }
          }
        } else {
          const text = await file.text();
          const parsed = JSON.parse(text);
          clientFc = normalize(parsed);
          featureCount = clientFc.features.length;
          const response = await fetch("/api/datasets/upload", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ name, featureCollection: clientFc, projectId }),
          });
          body = (await response.json().catch(() => ({}))) as {
            ok: boolean;
            layerId?: string;
            error?: string;
          };
          if (!response.ok || !body.ok || !body.layerId) {
            throw new Error(body.error ?? `Upload failed (${response.status}).`);
          }
        }

        onLayerAdded({
          id: body.layerId,
          name,
          color: pickColor(),
          visible: true,
          source: "upload",
          data: clientFc ?? { type: "FeatureCollection", features: [] },
          featureCount,
        });
      } catch (e) {
        setError((e as Error).message);
      } finally {
        setUploading(false);
      }
    },
    [onLayerAdded, projectId],
  );

  return (
    <section className="border-b border-[color:var(--border)] px-5 py-4">
      <label
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          void onFiles(e.dataTransfer.files);
        }}
        className={`flex cursor-pointer flex-col items-center justify-center gap-1 rounded-md border-2 border-dashed px-4 py-6 text-center transition ${
          dragging
            ? "border-[color:var(--accent)] bg-[color:var(--accent)]/10"
            : "border-[color:var(--border)] hover:border-[color:var(--accent)]"
        } ${uploading ? "opacity-60" : ""}`}
      >
        <Upload size={16} className="text-[color:var(--muted)]" />
        <span className="text-xs font-medium">
          {uploading ? "Uploading…" : "Drop a GeoJSON or shapefile .zip"}
        </span>
        <span className="text-[10px] text-[color:var(--muted)]">
          or click to choose
        </span>
        <input
          ref={inputRef}
          type="file"
          accept=".geojson,.json,application/json,application/geo+json,.zip,application/zip"
          hidden
          disabled={uploading}
          onChange={(e) => void onFiles(e.target.files)}
        />
      </label>
      {error && <p className="mt-2 text-xs text-red-500">{error}</p>}
    </section>
  );
}

function normalize(raw: unknown): GeoJSON.FeatureCollection {
  if (typeof raw !== "object" || raw === null) throw new Error("Not JSON.");
  const v = raw as { type?: string; features?: unknown };
  if (v.type === "FeatureCollection" && Array.isArray(v.features)) {
    return raw as GeoJSON.FeatureCollection;
  }
  if (v.type === "Feature") {
    return { type: "FeatureCollection", features: [raw as GeoJSON.Feature] };
  }
  if (typeof v.type === "string" && "coordinates" in (raw as object)) {
    return {
      type: "FeatureCollection",
      features: [
        { type: "Feature", properties: {}, geometry: raw as GeoJSON.Geometry },
      ],
    };
  }
  throw new Error("Unrecognized GeoJSON shape.");
}
