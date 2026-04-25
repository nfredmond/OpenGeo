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

function projectApiPath(projectSlug: string, projectId: string, suffix: string): string {
  return `/api/projects/${projectSlug}/${suffix}?projectId=${encodeURIComponent(projectId)}`;
}

export function SharePanel({
  projectSlug,
  projectId,
}: {
  projectSlug: string;
  projectId: string;
}) {
  const [state, setState] = useState<MembersPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(projectApiPath(projectSlug, projectId, "members"), {
        cache: "no-store",
      });
      const body = (await res.json()) as MembersPayload;
      if (!res.ok || !body.ok) throw new Error(body.error ?? `Request failed (${res.status})`);
      setState(body);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [projectSlug, projectId]);

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
      {canAdmin && (
        <InviteForm projectSlug={projectSlug} projectId={projectId} onInvited={load} />
      )}

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
                    projectId={projectId}
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
                    projectId={projectId}
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

      {canAdmin && <DashboardPublisher projectSlug={projectSlug} projectId={projectId} />}

      {canAdmin && <ShareLinkManager projectSlug={projectSlug} projectId={projectId} />}
    </div>
  );
}

function InviteForm({
  projectSlug,
  projectId,
  onInvited,
}: {
  projectSlug: string;
  projectId: string;
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
      const res = await fetch(projectApiPath(projectSlug, projectId, "members"), {
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
  projectId,
  userId,
  label,
  onRemoved,
}: {
  projectSlug: string;
  projectId: string;
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
        projectApiPath(projectSlug, projectId, `members/${userId}`),
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
  projectId,
  invitationId,
  email,
  onCancelled,
}: {
  projectSlug: string;
  projectId: string;
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
        projectApiPath(projectSlug, projectId, `invitations/${invitationId}`),
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

type DashboardLayer = {
  id: string;
  name: string;
  featureCount: number;
};

type DashboardConfig = {
  id: string;
  name: string;
  isPublished: boolean;
  layerId: string;
  layerName: string;
  metric: {
    kind: "feature_count";
    label: string;
    value: number;
  };
};

function DashboardPublisher({
  projectSlug,
  projectId,
}: {
  projectSlug: string;
  projectId: string;
}) {
  const [dashboard, setDashboard] = useState<DashboardConfig | null>(null);
  const [pmtilesLayers, setPmtilesLayers] = useState<DashboardLayer[]>([]);
  const [name, setName] = useState("Public dashboard");
  const [layerId, setLayerId] = useState("");
  const [isPublished, setIsPublished] = useState(true);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(projectApiPath(projectSlug, projectId, "dashboard"), {
        cache: "no-store",
      });
      const body = (await res.json()) as {
        ok: boolean;
        dashboard?: DashboardConfig | null;
        pmtilesLayers?: DashboardLayer[];
        error?: string;
      };
      if (!res.ok || !body.ok) throw new Error(body.error ?? `Failed (${res.status})`);

      const layers = body.pmtilesLayers ?? [];
      const existing = body.dashboard ?? null;
      setDashboard(existing);
      setPmtilesLayers(layers);
      if (existing) {
        setName(existing.name);
        setLayerId(existing.layerId);
        setIsPublished(existing.isPublished);
      } else {
        setName("Public dashboard");
        setLayerId(layers[0]?.id ?? "");
        setIsPublished(true);
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [projectSlug, projectId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (saving || !layerId) return;
    setSaving(true);
    setError(null);
    setNote(null);
    try {
      const res = await fetch(projectApiPath(projectSlug, projectId, "dashboard"), {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: name.trim() || "Public dashboard",
          layerId,
          isPublished,
        }),
      });
      const body = (await res.json()) as {
        ok: boolean;
        dashboard?: DashboardConfig;
        pmtilesLayers?: DashboardLayer[];
        error?: string;
      };
      if (!res.ok || !body.ok || !body.dashboard) {
        throw new Error(body.error ?? `Failed (${res.status})`);
      }
      setDashboard(body.dashboard);
      setPmtilesLayers(body.pmtilesLayers ?? pmtilesLayers);
      setName(body.dashboard.name);
      setLayerId(body.dashboard.layerId);
      setIsPublished(body.dashboard.isPublished);
      setNote(body.dashboard.isPublished ? "Dashboard published." : "Dashboard saved.");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  const selectedLayer = pmtilesLayers.find((layer) => layer.id === layerId);
  const metricValue = dashboard && selectedLayer && dashboard.layerId === selectedLayer.id
    ? dashboard.metric.value
    : selectedLayer?.featureCount;

  return (
    <section className="rounded-md border border-[color:var(--border)] bg-[color:var(--card)] p-4">
      <header className="mb-3">
        <h2 className="text-xs font-semibold uppercase tracking-wider text-[color:var(--muted)]">
          Public dashboard
        </h2>
      </header>

      {loading ? (
        <p className="text-sm text-[color:var(--muted)]">Loading…</p>
      ) : (
        <form onSubmit={save} className="grid gap-3">
          <div className="grid gap-2 md:grid-cols-[1fr_1fr]">
            <label className="flex flex-col text-[11px]">
              <span className="mb-1 text-[color:var(--muted)]">Title</span>
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                className="rounded border border-[color:var(--border)] bg-[color:var(--background)] px-2 py-1.5 text-sm outline-none focus:border-[color:var(--accent)]"
                maxLength={120}
                required
              />
            </label>
            <label className="flex flex-col text-[11px]">
              <span className="mb-1 text-[color:var(--muted)]">PMTiles layer</span>
              <select
                value={layerId}
                onChange={(e) => setLayerId(e.target.value)}
                className="rounded border border-[color:var(--border)] bg-[color:var(--background)] px-2 py-1.5 text-sm outline-none focus:border-[color:var(--accent)]"
                disabled={pmtilesLayers.length === 0}
                required
              >
                {pmtilesLayers.length === 0 ? (
                  <option value="">No PMTiles layers</option>
                ) : (
                  pmtilesLayers.map((layer) => (
                    <option key={layer.id} value={layer.id}>
                      {layer.name}
                    </option>
                  ))
                )}
              </select>
            </label>
          </div>

          <div className="flex flex-wrap items-end justify-between gap-3 border-t border-[color:var(--border)] pt-3">
            <label className="flex items-center gap-2 text-xs">
              <input
                type="checkbox"
                checked={isPublished}
                onChange={(e) => setIsPublished(e.target.checked)}
              />
              <span>Published</span>
            </label>
            {selectedLayer && (
              <div className="min-w-0 text-right">
                <p className="text-[10px] uppercase tracking-wider text-[color:var(--muted)]">
                  Features
                </p>
                <p className="text-lg font-semibold">{formatCount(metricValue ?? 0)}</p>
              </div>
            )}
            <button
              type="submit"
              disabled={saving || !layerId || pmtilesLayers.length === 0}
              className="rounded bg-[color:var(--accent)] px-3 py-1.5 text-xs font-medium text-white transition hover:opacity-90 disabled:opacity-50"
            >
              {saving ? "Saving…" : "Save dashboard"}
            </button>
          </div>
        </form>
      )}

      {note && <p className="mt-2 text-xs text-[color:var(--muted)]">{note}</p>}
      {error && <p className="mt-2 text-xs text-red-500">{error}</p>}
    </section>
  );
}

type ShareLink = {
  id: string;
  prefix: string;
  scopes: string[];
  expiresAt: string | null;
  revokedAt: string | null;
  lastUsedAt: string | null;
  createdAt: string;
};

function ShareLinkManager({ projectSlug, projectId }: { projectSlug: string; projectId: string }) {
  const [links, setLinks] = useState<ShareLink[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [minting, setMinting] = useState(false);
  const [expiresInDays, setExpiresInDays] = useState<string>("30");
  // Newly-minted token shown exactly once, then cleared when the user copies
  // it or moves on.
  const [newToken, setNewToken] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(projectApiPath(projectSlug, projectId, "share-links"), {
        cache: "no-store",
      });
      const body = (await res.json()) as { ok: boolean; tokens?: ShareLink[]; error?: string };
      if (!res.ok || !body.ok) throw new Error(body.error ?? `Failed (${res.status})`);
      setLinks(body.tokens ?? []);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [projectSlug, projectId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function mint() {
    setMinting(true);
    setError(null);
    setCopied(false);
    try {
      const days = expiresInDays.trim()
        ? Math.max(1, Math.min(3650, parseInt(expiresInDays, 10)))
        : undefined;
      const res = await fetch(projectApiPath(projectSlug, projectId, "share-links"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(days ? { expiresInDays: days } : {}),
      });
      const body = (await res.json()) as { ok: boolean; token?: string; error?: string };
      if (!res.ok || !body.ok || !body.token) {
        throw new Error(body.error ?? `Failed (${res.status})`);
      }
      setNewToken(body.token);
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setMinting(false);
    }
  }

  async function revoke(id: string, prefix: string) {
    if (!confirm(`Revoke share link "${prefix}…"? Anyone holding it will lose access immediately.`)) return;
    try {
      const res = await fetch(
        projectApiPath(projectSlug, projectId, `share-links/${id}`),
        { method: "DELETE" },
      );
      const body = (await res.json()) as { ok: boolean; error?: string };
      if (!res.ok || !body.ok) throw new Error(body.error ?? `Failed (${res.status})`);
      await load();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function copyToken() {
    if (!newToken) return;
    try {
      await navigator.clipboard.writeText(`${window.location.origin}/p/${newToken}`);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  }

  const activeLinks = links.filter((l) => !l.revokedAt);

  return (
    <section className="rounded-md border border-[color:var(--border)] bg-[color:var(--card)] p-4">
      <header className="mb-3 flex items-center justify-between">
        <h2 className="text-xs font-semibold uppercase tracking-wider text-[color:var(--muted)]">
          Public share links ({activeLinks.length})
        </h2>
      </header>

      <div className="mb-4 rounded border border-[color:var(--border)] bg-[color:var(--background)] p-3">
        <p className="mb-2 text-xs text-[color:var(--muted)]">
          Mint a read-only link. Anyone with the URL can view the map. No sign-up needed.
        </p>
        <div className="flex items-end gap-2">
          <label className="flex flex-col text-[11px]">
            <span className="mb-1 text-[color:var(--muted)]">Expires in (days)</span>
            <input
              type="number"
              min={1}
              max={3650}
              value={expiresInDays}
              onChange={(e) => setExpiresInDays(e.target.value)}
              className="w-24 rounded border border-[color:var(--border)] bg-[color:var(--card)] px-2 py-1 text-sm"
            />
          </label>
          <button
            onClick={() => void mint()}
            disabled={minting}
            className="rounded bg-[color:var(--accent)] px-3 py-1.5 text-xs font-medium text-white transition hover:opacity-90 disabled:opacity-50"
          >
            {minting ? "Minting…" : "Mint link"}
          </button>
        </div>
        {newToken && (
          <div className="mt-3 rounded border border-amber-500/40 bg-amber-500/10 p-3 text-xs">
            <p className="mb-2 font-semibold text-amber-800">
              Copy this link now — it won&apos;t be shown again.
            </p>
            <div className="flex items-center gap-2">
              <code className="flex-1 truncate rounded bg-[color:var(--card)] px-2 py-1 font-mono text-[11px]">
                {typeof window !== "undefined" ? window.location.origin : ""}/p/{newToken}
              </code>
              <button
                onClick={() => void copyToken()}
                className="rounded border border-[color:var(--border)] px-2 py-1 text-[11px] hover:border-[color:var(--accent)]"
              >
                {copied ? "Copied" : "Copy"}
              </button>
              <button
                onClick={() => setNewToken(null)}
                className="rounded border border-[color:var(--border)] px-2 py-1 text-[11px] text-[color:var(--muted)] hover:border-[color:var(--foreground)]"
              >
                Dismiss
              </button>
            </div>
          </div>
        )}
      </div>

      {loading ? (
        <p className="text-sm text-[color:var(--muted)]">Loading…</p>
      ) : activeLinks.length === 0 ? (
        <p className="text-sm text-[color:var(--muted)]">No active share links.</p>
      ) : (
        <ul className="divide-y divide-[color:var(--border)]">
          {activeLinks.map((l) => (
            <li key={l.id} className="flex items-center justify-between py-2 text-sm">
              <div className="min-w-0">
                <p className="truncate font-mono text-xs">{l.prefix}…</p>
                <p className="text-[11px] text-[color:var(--muted)]">
                  {l.scopes.join(", ")} ·{" "}
                  {l.expiresAt
                    ? `expires ${new Date(l.expiresAt).toLocaleDateString()}`
                    : "no expiry"}
                  {l.lastUsedAt ? ` · last used ${new Date(l.lastUsedAt).toLocaleDateString()}` : ""}
                </p>
              </div>
              <button
                onClick={() => void revoke(l.id, l.prefix)}
                className="rounded border border-[color:var(--border)] px-2 py-1 text-[11px] text-[color:var(--muted)] hover:border-red-500 hover:text-red-500"
              >
                Revoke
              </button>
            </li>
          ))}
        </ul>
      )}
      {error && <p className="mt-2 text-xs text-red-500">{error}</p>}
    </section>
  );
}

function formatCount(value: number): string {
  return new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 }).format(value);
}
