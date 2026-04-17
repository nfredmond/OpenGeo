import JSZip from "jszip";
import * as shapefile from "shapefile";

export type ShapefileComponent = "shp" | "shx" | "dbf" | "prj" | "cpg";

export type DecodedShapefile = {
  featureCollection: GeoJSON.FeatureCollection;
  prjWkt: string | null;
  componentsFound: ShapefileComponent[];
  baseName: string;
};

// Decodes a `.zip` containing a shapefile triad (.shp + .dbf + optional
// .shx/.prj/.cpg) into an unprojected GeoJSON FeatureCollection. Pure JS —
// runs on Node runtimes without a GDAL binding. The caller handles CRS
// detection and reprojection based on prjWkt.
//
// Only the first shapefile inside the archive is decoded; additional .shp
// files are ignored (and the list of sibling components is scoped to that
// first base name). This matches what ArcGIS/QGIS exports typically look
// like and keeps the upload contract one-layer-per-file.
export async function decodeShapefileZip(
  zipBytes: Uint8Array,
): Promise<DecodedShapefile> {
  const zip = await JSZip.loadAsync(zipBytes);
  const entries = Object.values(zip.files).filter((f) => !f.dir);

  const shpEntry = entries.find((e) => e.name.toLowerCase().endsWith(".shp"));
  if (!shpEntry) {
    throw new Error("No .shp file found in archive.");
  }
  const baseName = shpEntry.name.slice(0, -4);

  const sibling = (ext: string) => {
    const want = (baseName + ext).toLowerCase();
    return entries.find((e) => e.name.toLowerCase() === want);
  };

  const dbfEntry = sibling(".dbf");
  if (!dbfEntry) {
    throw new Error(
      `Missing .dbf sibling for ${shpEntry.name} — a shapefile triad (.shp + .shx + .dbf) is required.`,
    );
  }
  const prjEntry = sibling(".prj");
  const cpgEntry = sibling(".cpg");

  const components: ShapefileComponent[] = ["shp", "dbf"];
  if (sibling(".shx")) components.push("shx");
  if (prjEntry) components.push("prj");
  if (cpgEntry) components.push("cpg");

  const shpBuf = await shpEntry.async("uint8array");
  const dbfBuf = await dbfEntry.async("uint8array");
  const prjWkt = prjEntry ? (await prjEntry.async("string")).trim() : null;

  const encoding = cpgEntry
    ? normalizeCpg((await cpgEntry.async("string")).trim())
    : "utf-8";

  const source = await shapefile.open(shpBuf, dbfBuf, { encoding });
  const features: GeoJSON.Feature[] = [];
  while (true) {
    const { done, value } = await source.read();
    if (done) break;
    if (value) features.push(value as GeoJSON.Feature);
  }

  return {
    featureCollection: { type: "FeatureCollection", features },
    prjWkt,
    componentsFound: components,
    baseName,
  };
}

function normalizeCpg(raw: string): string {
  const v = raw.toLowerCase().replace(/\s+/g, "");
  if (v === "utf8" || v === "utf-8") return "utf-8";
  if (v === "latin1" || v === "iso-8859-1" || v === "iso8859-1") return "iso-8859-1";
  return v || "utf-8";
}
