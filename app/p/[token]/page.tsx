import { PublicMap } from "./public-map";

// Public share-link landing page. No auth, no layout chrome — the share token
// itself is the capability. All data fetching happens client-side against
// /api/share/[token]/* which validates the token and returns 404 on any
// invalid/expired/revoked case.
export const dynamic = "force-dynamic";

type Props = { params: Promise<{ token: string }> };

export default async function PublicSharePage({ params }: Props) {
  const { token } = await params;
  return <PublicMap token={token} />;
}
