import proj4 from "proj4";

// Reprojects every geometry in a FeatureCollection from `fromDef` to
// EPSG:4326 (longitude/latitude, WGS84). Properties pass through unchanged.
// `fromDef` may be a proj4 string, a WKT string, or an EPSG code like
// "EPSG:26910" — proj4 accepts all three.
//
// This is a best-effort spatial transform: coordinates that already sit in
// 4326 are left intact if the caller passes "EPSG:4326" as `fromDef`.
// Z/M values are dropped because the downstream ingest_geojson RPC writes
// planar geometry (PostGIS `geometry(Geometry, 4326)`); reintroducing them
// is a Phase 2 concern.
export function reprojectFeatureCollection(
  fc: GeoJSON.FeatureCollection,
  fromDef: string,
  toDef = "EPSG:4326",
): GeoJSON.FeatureCollection {
  if (fromDef === toDef) return fc;
  const transformer = proj4(fromDef, toDef);
  const fwd = (xy: number[]): [number, number] => {
    const [x, y] = transformer.forward([xy[0], xy[1]]);
    return [x, y];
  };
  return {
    type: "FeatureCollection",
    features: fc.features.map((f) => ({
      ...f,
      geometry: f.geometry ? reprojectGeometry(f.geometry, fwd) : f.geometry,
    })),
  };
}

function reprojectGeometry(
  g: GeoJSON.Geometry,
  fwd: (xy: number[]) => [number, number],
): GeoJSON.Geometry {
  switch (g.type) {
    case "Point":
      return { type: "Point", coordinates: fwd(g.coordinates) };
    case "MultiPoint":
      return { type: "MultiPoint", coordinates: g.coordinates.map(fwd) };
    case "LineString":
      return { type: "LineString", coordinates: g.coordinates.map(fwd) };
    case "MultiLineString":
      return {
        type: "MultiLineString",
        coordinates: g.coordinates.map((line) => line.map(fwd)),
      };
    case "Polygon":
      return {
        type: "Polygon",
        coordinates: g.coordinates.map((ring) => ring.map(fwd)),
      };
    case "MultiPolygon":
      return {
        type: "MultiPolygon",
        coordinates: g.coordinates.map((poly) => poly.map((ring) => ring.map(fwd))),
      };
    case "GeometryCollection":
      return {
        type: "GeometryCollection",
        geometries: g.geometries.map((x) => reprojectGeometry(x, fwd)),
      };
  }
}

// Pull the first (x, y) pair out of a FeatureCollection — useful for
// coord-bounds-based CRS heuristics when a .prj is missing.
export function firstCoordinate(
  fc: GeoJSON.FeatureCollection,
): [number, number] | null {
  for (const f of fc.features) {
    const g = f.geometry;
    if (!g) continue;
    const c = firstCoordOfGeometry(g);
    if (c) return c;
  }
  return null;
}

function firstCoordOfGeometry(g: GeoJSON.Geometry): [number, number] | null {
  switch (g.type) {
    case "Point":
      return [g.coordinates[0], g.coordinates[1]];
    case "MultiPoint":
    case "LineString":
      return g.coordinates[0] ? [g.coordinates[0][0], g.coordinates[0][1]] : null;
    case "MultiLineString":
    case "Polygon":
      return g.coordinates[0]?.[0]
        ? [g.coordinates[0][0][0], g.coordinates[0][0][1]]
        : null;
    case "MultiPolygon":
      return g.coordinates[0]?.[0]?.[0]
        ? [g.coordinates[0][0][0][0], g.coordinates[0][0][0][1]]
        : null;
    case "GeometryCollection":
      for (const sub of g.geometries) {
        const c = firstCoordOfGeometry(sub);
        if (c) return c;
      }
      return null;
  }
}
