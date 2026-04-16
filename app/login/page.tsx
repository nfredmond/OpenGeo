import { redirect } from "next/navigation";
import { supabaseServer } from "@/lib/supabase/server";
import { LoginForm } from "./login-form";

export const dynamic = "force-dynamic";

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

export default async function LoginPage({ searchParams }: { searchParams: SearchParams }) {
  const params = await searchParams;
  const supabase = await supabaseServer();
  const { data } = await supabase.auth.getUser();
  if (data.user) {
    const next = typeof params.next === "string" ? params.next : "/map";
    redirect(next);
  }

  const nextParam = typeof params.next === "string" ? params.next : "/map";
  const errorParam = typeof params.error === "string" ? params.error : undefined;

  return (
    <div className="flex min-h-screen items-center justify-center bg-[color:var(--background)] px-4">
      <div className="w-full max-w-sm">
        <div className="mb-8 text-center">
          <h1 className="text-xl font-semibold tracking-tight">OpenGeo</h1>
          <p className="mt-1 text-sm text-[color:var(--muted)]">
            drone-to-insight workspace
          </p>
        </div>
        <LoginForm next={nextParam} initialError={errorParam} />
      </div>
    </div>
  );
}
