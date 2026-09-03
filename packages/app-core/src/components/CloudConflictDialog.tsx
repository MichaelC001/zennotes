import { useState } from "react";
import type { CloudSyncRunSummary } from "@zennotes/bridge-contract/cloud-sync";
import { CloudBootstrapConflictResolver } from "./CloudBootstrapConflictResolver";
import { CloudPendingConflictResolver } from "./CloudPendingConflictResolver";
import { Modal } from "./ui/Modal";

const TITLE_ID = "cloud-conflict-dialog-title";

export function CloudConflictDialog({
  summary,
  vaultName,
  onClose,
}: {
  summary: CloudSyncRunSummary;
  vaultName: string;
  onClose: () => void;
}): JSX.Element {
  const pending = summary.pending_conflicts ?? [];
  const conflicts = [
    ...pending.map((conflict) => ({ type: "pending" as const, conflict })),
    ...summary.bootstrap_conflicts.map((conflict) => ({
      type: "bootstrap" as const,
      conflict,
    })),
  ];
  const [selectedKey, setSelectedKey] = useState(
    () => conflictKey(conflicts[0]) ?? "",
  );
  const selected =
    conflicts.find((entry) => conflictKey(entry) === selectedKey) ??
    conflicts[0];
  const selectNext = (nextSummary: CloudSyncRunSummary): void => {
    const nextPending = nextSummary.pending_conflicts?.[0];
    if (nextPending) {
      setSelectedKey(`pending:${nextPending.id}`);
      return;
    }
    const nextBootstrap = nextSummary.bootstrap_conflicts[0];
    if (nextBootstrap) {
      setSelectedKey(`bootstrap:${nextBootstrap.item_id}`);
      return;
    }
    onClose();
  };

  return (
    <Modal
      size="xl"
      align="center"
      onClose={onClose}
      closeOnBackdrop={selected?.type !== "pending"}
      closeOnEsc={selected?.type !== "pending"}
      labelledBy={TITLE_ID}
      className="max-h-[88vh]"
      data={{ "data-cloud-conflict-dialog": "" }}
    >
      <Modal.Header
        title="Review sync changes"
        titleId={TITLE_ID}
        description={
          conflicts.length === 1
            ? "One file has changes from two devices. Compare both complete versions before choosing what to keep."
            : `${conflicts.length} files have changes from two devices. Review them one at a time; the next file stays available here.`
        }
      />
      <Modal.Body className="max-h-[72vh] overflow-y-auto">
        {conflicts.length > 1 && (
          <div className="mb-3 rounded-xl border border-paper-300/60 bg-paper-50/45 p-3">
            <div className="text-xs font-medium text-ink-700">
              Files to resolve
            </div>
            <div
              className="mt-2 flex max-h-28 flex-wrap gap-2 overflow-y-auto"
              aria-label="Unresolved Cloud conflicts"
            >
              {conflicts.map((entry) => {
                const key = conflictKey(entry);
                const active = key === conflictKey(selected);
                return (
                  <button
                    key={key}
                    type="button"
                    aria-pressed={active}
                    title={entry.conflict.path}
                    onClick={() => setSelectedKey(key)}
                    className={[
                      "max-w-full truncate rounded-lg border px-2.5 py-1.5 font-mono text-xs transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50",
                      active
                        ? "border-accent/40 bg-accent/10 text-ink-900"
                        : "border-paper-300/60 bg-paper-100 text-ink-600 hover:bg-paper-200/60 hover:text-ink-900",
                    ].join(" ")}
                  >
                    {entry.conflict.path}
                  </button>
                );
              })}
            </div>
          </div>
        )}

        {selected?.type === "pending" && (
          <CloudPendingConflictResolver
            key={selected.conflict.id}
            conflict={selected.conflict}
            vaultName={vaultName}
            onClose={onClose}
            onResolved={selectNext}
          />
        )}

        {selected?.type === "bootstrap" && (
          <CloudBootstrapConflictResolver
            key={`${selected.conflict.item_id}:${selected.conflict.local_sha256}:${selected.conflict.remote_sha256}`}
            conflict={selected.conflict}
            vaultName={vaultName}
            onClose={onClose}
            onResolved={selectNext}
          />
        )}
      </Modal.Body>
    </Modal>
  );
}

function conflictKey(
  entry:
    | {
        type: "pending";
        conflict: NonNullable<CloudSyncRunSummary["pending_conflicts"]>[number];
      }
    | {
        type: "bootstrap";
        conflict: CloudSyncRunSummary["bootstrap_conflicts"][number];
      }
    | undefined,
): string {
  if (!entry) return "";
  return `${entry.type}:${entry.type === "pending" ? entry.conflict.id : entry.conflict.item_id}`;
}
