"use client";

import { useCallback, useEffect, useState } from "react";

type Member = {
  userId: string;
  email: string | null;
  role: "owner" | "admin" | "editor" | "viewer" | string;
  scope: "org" | "project";
  invitedBy: string | null;
  createdAt: string;
};

type Invitation = {
  id: string;
  email: string;
  role: string;
  invitedBy: string | null;
  createdAt: string;
};

type MembersPayload = {
  ok: boolean;
  project?: { id: string; slug: string; name: string };
  members?: Member[];
  invitations?: Invitation[];
  viewerCanAdmin?: boolean;
  error?: string;
};

type InviteResponse = {
  ok: boolean;
  result?: "member_added" | "invitation_sent" | "invitation_created_email_failed";
  warning?: string;
  error?: string;
};

export function SharePanel({ projectSlug }: { projectSlug: string }) {
  const [state, setState] = useState<MembersPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/projects/${projectSlug}/members`, { cache: "no-store" });
      const body = (await res.json()) as MembersPayload;
      if (!res.ok || !body.ok) throw new Error(body.error ?? `Request failed (${res.status})`);
      setState(body);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [projectSlug]);

  useEffect(() => {
    void load();
  }, [load]);

  if (loading && !state) {
    return (
      <div className="rounded-md border border-[color:var(--border)] bg-[color:var(--card)] p-6 text-sm text-[color:var(--muted)]">
        Loading…
      </div>
    );
  }

  if (error) {
    return (
      <div className="rounded-md border border-red-500/40 bg-red-500/10 p-4 text-sm text-red-600">
        {error}
      </div>
    );
  }

  const canAdmin = state?.viewerCanAdmin ?? false;

  return (
    <div className="space-y-6">
      {canAdmin && <InviteForm projectSlug={projectSlug} onInvited={load} />}

      <section className="rounded-md border border-[color:var(--border)] bg-[color:var(--card)] p-4">
        <header className="mb-3 flex items-center justify-between">
          <h2 className="text-xs font-semibold uppercase tracking-wider text-[color:var(--muted)]">
            Members ({state?.members?.length ?? 0})
          </h2>
          {!canAdmin && (
            <span className="text-[10px] text-[color:var(--muted)]">
              Admins can invite or remove
            </span>
          )}
        </header>

        {(state?.members ?? []).length === 0 ? (
          <p className="text-sm text-[color:var(--muted)]">No members yet.</p>
        ) : (
          <ul className="divide-y divide-[color:var(--border)]">
            {(state?.members ?? []).map((m) => (
              <li
                key={`${m.scope}:${m.userId}`}
                className="flex items-center justify-between py-2 text-sm"
              >
                <div className="min-w-0">
                  <p className="truncate font-medium">
                    {m.email ?? `user ${m.userId.slice(0, 8)}…`}
                  </p>
                  <p className="text-[11px] text-[color:var(--muted)]">
                    <span className="uppercase tracking-wider">{m.scope}</span> ·{" "}
                    <span className="font-mono">{m.role}</span>
                  </p>
                </div>
                {canAdmin && m.scope === "project" && (
                  <RemoveButton
                    projectSlug={projectSlug}
                    userId={m.userId}
                    label={m.email ?? m.userId.slice(0, 8)}
                    onRemoved={load}
                  />
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      {canAdmin && (
        <section className="rounded-md border border-[color:var(--border)] bg-[color:var(--card)] p-4">
          <header className="mb-3">
            <h2 className="text-xs font-semibold uppercase tracking-wider text-[color:var(--muted)]">
              Pending invitations ({state?.invitations?.length ?? 0})
            </h2>
          </header>
          {(state?.invitations ?? []).length === 0 ? (
            <p className="text-sm text-[color:var(--muted)]">No pending invitations.</p>
          ) : (
            <ul className="divide-y divide-[color:var(--border)]">
              {(state?.invitations ?? []).map((inv) => (
                <li
                  key={inv.id}
                  className="flex items-center justify-between py-2 text-sm"
                >
                  <div className="min-w-0">
                    <p className="truncate font-medium">{inv.email}</p>
                    <p className="text-[11px] text-[color:var(--muted)]">
                      <span className="font-mono">{inv.role}</span> · invited{" "}
                      {new Date(inv.createdAt).toLocaleDateString()}
                    </p>
                  </div>
                  <CancelInviteButton
                    projectSlug={projectSlug}
                    invitationId={inv.id}
                    email={inv.email}
                    onCancelled={load}
                  />
                </li>
              ))}
            </ul>
          )}
        </section>
      )}
    </div>
  );
}

function InviteForm({
  projectSlug,
  onInvited,
}: {
  projectSlug: string;
  onInvited: () => Promise<void>;
}) {
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<"viewer" | "editor" | "admin">("viewer");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!email.trim() || busy) return;
    setBusy(true);
    setNote(null);
    setError(null);
    try {
      const res = await fetch(`/api/projects/${projectSlug}/members`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: email.trim(), role }),
      });
      const body = (await res.json()) as InviteResponse;
      if (!res.ok || !body.ok) throw new Error(body.error ?? `Request failed (${res.status})`);

      if (body.result === "member_added") {
        setNote(`${email.trim()} already had an account — added as ${role}.`);
      } else if (body.result === "invitation_sent") {
        setNote(`Invitation email sent to ${email.trim()}.`);
      } else if (body.result === "invitation_created_email_failed") {
        setNote(
          `Invitation recorded but email failed to send (${body.warning ?? "unknown"}). They can still accept via any magic-link path.`,
        );
      }
      setEmail("");
      await onInvited();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form
      onSubmit={onSubmit}
      className="rounded-md border border-[color:var(--border)] bg-[color:var(--card)] p-4"
    >
      <h2 className="mb-3 text-xs font-semibold uppercase tracking-wider text-[color:var(--muted)]">
        Invite a collaborator
      </h2>
      <div className="grid gap-2 md:grid-cols-[1fr_140px_auto]">
        <input
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="planner@example.com"
          className="rounded border border-[color:var(--border)] bg-[color:var(--background)] px-2 py-1.5 text-sm outline-none focus:border-[color:var(--accent)]"
          required
        />
        <select
          value={role}
          onChange={(e) => setRole(e.target.value as "viewer" | "editor" | "admin")}
          className="rounded border border-[color:var(--border)] bg-[color:var(--background)] px-2 py-1.5 text-sm outline-none focus:border-[color:var(--accent)]"
        >
          <option value="viewer">Viewer · can see</option>
          <option value="editor">Editor · can edit</option>
          <option value="admin">Admin · can invite</option>
        </select>
        <button
          type="submit"
          disabled={busy || !email.trim()}
          className="rounded bg-[color:var(--accent)] px-3 py-1.5 text-xs font-medium text-white transition hover:opacity-90 disabled:opacity-50"
        >
          {busy ? "Sending…" : "Send invite"}
        </button>
      </div>
      {note && <p className="mt-2 text-xs text-[color:var(--muted)]">{note}</p>}
      {error && <p className="mt-2 text-xs text-red-500">{error}</p>}
    </form>
  );
}

function RemoveButton({
  projectSlug,
  userId,
  label,
  onRemoved,
}: {
  projectSlug: string;
  userId: string;
  label: string;
  onRemoved: () => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onClick() {
    if (busy) return;
    if (!confirm(`Remove ${label} from this project?`)) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(
        `/api/projects/${projectSlug}/members/${userId}`,
        { method: "DELETE" },
      );
      const body = (await res.json()) as { ok: boolean; error?: string };
      if (!res.ok || !body.ok) throw new Error(body.error ?? `Request failed (${res.status})`);
      await onRemoved();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col items-end gap-1">
      <button
        onClick={() => void onClick()}
        disabled={busy}
        className="rounded border border-[color:var(--border)] px-2 py-1 text-[11px] text-[color:var(--muted)] hover:border-red-500 hover:text-red-500 disabled:opacity-50"
      >
        {busy ? "Removing…" : "Remove"}
      </button>
      {error && <p className="text-[10px] text-red-500">{error}</p>}
    </div>
  );
}

function CancelInviteButton({
  projectSlug,
  invitationId,
  email,
  onCancelled,
}: {
  projectSlug: string;
  invitationId: string;
  email: string;
  onCancelled: () => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onClick() {
    if (busy) return;
    if (!confirm(`Cancel pending invitation for ${email}?`)) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(
        `/api/projects/${projectSlug}/invitations/${invitationId}`,
        { method: "DELETE" },
      );
      const body = (await res.json()) as { ok: boolean; error?: string };
      if (!res.ok || !body.ok) throw new Error(body.error ?? `Request failed (${res.status})`);
      await onCancelled();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col items-end gap-1">
      <button
        onClick={() => void onClick()}
        disabled={busy}
        className="rounded border border-[color:var(--border)] px-2 py-1 text-[11px] text-[color:var(--muted)] hover:border-red-500 hover:text-red-500 disabled:opacity-50"
      >
        {busy ? "Cancelling…" : "Cancel"}
      </button>
      {error && <p className="text-[10px] text-red-500">{error}</p>}
    </div>
  );
}
