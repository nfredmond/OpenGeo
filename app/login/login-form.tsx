"use client";

import { useState } from "react";
import { supabaseClient } from "@/lib/supabase/client";

export function LoginForm({ next, initialError }: { next: string; initialError?: string }) {
  const [email, setEmail] = useState("");
  const [status, setStatus] = useState<"idle" | "sending" | "sent">("idle");
  const [error, setError] = useState<string | null>(initialError ?? null);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setStatus("sending");
    setError(null);
    const supabase = supabaseClient();
    const redirectTo = new URL(
      `/auth/callback?next=${encodeURIComponent(next)}`,
      window.location.origin,
    ).toString();
    const { error: err } = await supabase.auth.signInWithOtp({
      email,
      options: { emailRedirectTo: redirectTo },
    });
    if (err) {
      setError(err.message);
      setStatus("idle");
      return;
    }
    setStatus("sent");
  }

  if (status === "sent") {
    return (
      <div className="rounded-md border border-[color:var(--border)] bg-[color:var(--card)] p-5 text-sm">
        <p className="font-medium">Check your email.</p>
        <p className="mt-1 text-[color:var(--muted)]">
          We sent a sign-in link to <span className="text-[color:var(--foreground)]">{email}</span>. Open it on this device to finish signing in.
        </p>
      </div>
    );
  }

  return (
    <form onSubmit={onSubmit} className="space-y-3 rounded-md border border-[color:var(--border)] bg-[color:var(--card)] p-5">
      <label htmlFor="email" className="block text-xs font-medium uppercase tracking-wider text-[color:var(--muted)]">
        Email
      </label>
      <input
        id="email"
        type="email"
        required
        autoComplete="email"
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        placeholder="you@example.com"
        className="w-full rounded border border-[color:var(--border)] bg-[color:var(--background)] px-3 py-2 text-sm outline-none focus:border-[color:var(--accent)]"
      />
      <button
        type="submit"
        disabled={status === "sending" || email.length === 0}
        className="w-full rounded bg-[color:var(--accent)] px-3 py-2 text-sm font-medium text-white transition hover:opacity-90 disabled:opacity-60"
      >
        {status === "sending" ? "Sending…" : "Send magic link"}
      </button>
      {error && <p className="text-xs text-red-500">{error}</p>}
      <p className="text-[10px] text-[color:var(--muted)]">
        OpenGeo uses passwordless email sign-in. No accounts, no passwords to forget.
      </p>
    </form>
  );
}
