import { useEffect, useMemo, useState } from "react";
import type {
  CloudSyncBootstrapConflict,
  CloudSyncBootstrapConflictDetails,
  CloudSyncBootstrapConflictResolution,
  CloudSyncRunSummary,
} from "@zennotes/bridge-contract/cloud-sync";
import { getZenBridge } from "@zennotes/bridge-contract/bridge";
import { syncCloudVaultWithStatus } from "../lib/cloud-auto-sync";
import { Button } from "./ui/Button";

export function CloudBootstrapConflictResolver({
  conflict,
  vaultName,
  onResolved,
  onClose,
}: {
  conflict: CloudSyncBootstrapConflict;
  vaultName: string;
  onResolved: (summary: CloudSyncRunSummary) => void;
  onClose: () => void;
}): JSX.Element {
  const [bridge] = useState(() => getZenBridge());
  const [details, setDetails] =
    useState<CloudSyncBootstrapConflictDetails | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [mode, setMode] = useState<"choices" | "both" | "merge">("choices");
  const [keepBothPath, setKeepBothPath] = useState(() =>
    localCopyPath(conflict.path),
  );
  const [mergedText, setMergedText] = useState("");

  useEffect(() => {
    let cancelled = false;
    setDetails(null);
    setError(null);
    void bridge
      .getCloudBootstrapConflict(conflict)
      .then((next) => {
        if (cancelled) return;
        setDetails(next);
        setMergedText(next.local.text ?? "");
      })
      .catch((cause) => {
        if (!cancelled) setError(message(cause));
      });
    return () => {
      cancelled = true;
    };
  }, [bridge, conflict]);

  const canMerge = Boolean(
    details && details.local.text !== null && details.cloud.text !== null,
  );
  const titleId = useMemo(
    () => `cloud-conflict-${conflict.item_id.replace(/[^a-zA-Z0-9_-]/g, "-")}`,
    [conflict.item_id],
  );

  const resolve = async (
    resolution: Omit<CloudSyncBootstrapConflictResolution, "conflict">,
  ): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      await bridge.resolveCloudBootstrapConflict({ conflict, ...resolution });
      onResolved(await syncCloudVaultWithStatus(bridge, vaultName));
    } catch (cause) {
      setError(message(cause));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section
      aria-labelledby={titleId}
      className="rounded-xl border border-warning/35 bg-paper-50 px-3 py-3"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h4 id={titleId} className="text-sm font-semibold text-ink-900">
            Compare versions
          </h4>
          <div
            className="mt-1 truncate font-mono text-xs text-ink-500"
            title={conflict.path}
          >
            {conflict.path}
          </div>
        </div>
        <Button variant="ghost" disabled={busy} onClick={onClose}>
          Resolve later
        </Button>
      </div>

      {error && (
        <div
          role="alert"
          className="mt-3 rounded-lg border border-danger/35 bg-danger/10 px-3 py-2 text-xs leading-5 text-danger"
        >
          {error}
        </div>
      )}

      {!details && !error && (
        <div role="status" className="mt-3 text-xs text-ink-500">
          Loading both versions…
        </div>
      )}

      {details && (
        <>
          <div className="mt-3 grid gap-3 md:grid-cols-2">
            <VersionPreview label="This device" text={details.local.text} />
            <VersionPreview label="Cloud" text={details.cloud.text} />
          </div>

          {mode === "both" && (
            <div className="mt-3 rounded-lg border border-paper-300/60 bg-paper-100/45 p-3">
              <label
                htmlFor={`${titleId}-copy-path`}
                className="text-xs font-medium text-ink-800"
              >
                Filename for this device&rsquo;s version
              </label>
              <input
                id={`${titleId}-copy-path`}
                value={keepBothPath}
                disabled={busy}
                onChange={(event) => setKeepBothPath(event.target.value)}
                className="mt-2 w-full rounded-lg border border-paper-300 bg-paper-50 px-3 py-2 font-mono text-xs text-ink-900 outline-none focus:border-accent disabled:opacity-50"
              />
              <div className="mt-3 flex flex-wrap gap-2">
                <Button
                  variant="primary"
                  disabled={busy || !keepBothPath.trim()}
                  onClick={() =>
                    void resolve({
                      choice: "both",
                      keep_both_path: keepBothPath.trim(),
                    })
                  }
                >
                  {busy ? "Keeping both…" : "Keep both versions"}
                </Button>
                <Button
                  variant="ghost"
                  disabled={busy}
                  onClick={() => setMode("choices")}
                >
                  Back
                </Button>
              </div>
            </div>
          )}

          {mode === "merge" && canMerge && (
            <div className="mt-3 rounded-lg border border-paper-300/60 bg-paper-100/45 p-3">
              <label
                htmlFor={`${titleId}-merged`}
                className="text-xs font-medium text-ink-800"
              >
                Merged result
              </label>
              <textarea
                id={`${titleId}-merged`}
                value={mergedText}
                disabled={busy}
                onChange={(event) => setMergedText(event.target.value)}
                className="mt-2 min-h-48 w-full resize-y rounded-lg border border-paper-300 bg-paper-50 px-3 py-2 font-mono text-xs leading-5 text-ink-900 outline-none focus:border-accent disabled:opacity-50"
              />
              <div className="mt-3 flex flex-wrap gap-2">
                <Button
                  variant="primary"
                  disabled={busy}
                  onClick={() =>
                    void resolve({ choice: "merged", merged_text: mergedText })
                  }
                >
                  {busy ? "Saving merge…" : "Save merged version"}
                </Button>
                <Button
                  variant="ghost"
                  disabled={busy}
                  onClick={() => setMode("choices")}
                >
                  Back
                </Button>
              </div>
            </div>
          )}

          {mode === "choices" && (
            <div
              className="mt-3 flex flex-wrap gap-2"
              aria-label="Conflict resolution choices"
            >
              <Button
                variant="secondary"
                disabled={busy}
                onClick={() => void resolve({ choice: "local" })}
              >
                {busy ? "Resolving…" : "Keep this device’s version"}
              </Button>
              <Button
                variant="secondary"
                disabled={busy}
                onClick={() => void resolve({ choice: "cloud" })}
              >
                Use Cloud version
              </Button>
              <Button
                variant="ghost"
                disabled={busy}
                onClick={() => setMode("both")}
              >
                Keep both…
              </Button>
              {canMerge && (
                <Button
                  variant="ghost"
                  disabled={busy}
                  onClick={() => setMode("merge")}
                >
                  Merge manually…
                </Button>
              )}
            </div>
          )}
        </>
      )}
    </section>
  );
}

function VersionPreview({
  label,
  text,
}: {
  label: string;
  text: string | null;
}): JSX.Element {
  return (
    <div className="min-w-0 overflow-hidden rounded-lg border border-paper-300/60 bg-paper-100/45">
      <div className="border-b border-paper-300/60 px-3 py-2 text-xs font-semibold text-ink-800">
        {label}
      </div>
      {text === null ? (
        <div className="px-3 py-4 text-xs leading-5 text-ink-500">
          Preview unavailable. You can still keep either complete file.
        </div>
      ) : (
        <pre className="max-h-56 overflow-auto whitespace-pre-wrap break-words px-3 py-3 font-mono text-xs leading-5 text-ink-700">
          {text || "(empty file)"}
        </pre>
      )}
    </div>
  );
}

function localCopyPath(path: string): string {
  const slash = path.lastIndexOf("/");
  const directory = slash >= 0 ? path.slice(0, slash + 1) : "";
  const filename = slash >= 0 ? path.slice(slash + 1) : path;
  const dot = filename.lastIndexOf(".");
  return dot > 0
    ? `${directory}${filename.slice(0, dot)} (this device)${filename.slice(dot)}`
    : `${directory}${filename} (this device)`;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
