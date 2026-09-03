ZenNotes 2.44.0: Cloud conflicts become clear choices

> ZenNotes now combines safe edits automatically and asks for help only when two devices changed the same words. Every version stays safe until you choose, and sync no longer creates surprise `(cloud conflict)` notes.

## ✨ New

- **Review sync changes where you already work.** (#683, reported by @uNyanda) A persistent **1 file needs review · Review now** action appears in the workspace status bar, with the same queue available in Settings → Cloud. The resolver lists every file waiting for a decision and moves to the next one automatically. While files are waiting, the command palette entry **Review Cloud Sync Conflicts** and the Vim leader binding `Space r` open the same queue.
- **Resolve only the ambiguous part.** ZenNotes three-way merges edits made in different places without interrupting you. For a real overlap, the resolver labels the versions **This device**, **Other device**, and **Last synced**, shows the suggested combined note, and asks which wording to keep for each ambiguous change. You can edit the combined note directly or choose one complete version instead.
- **An honest first-sync choice.** When there is no earlier shared version, ZenNotes does not pretend it can infer a merge. It shows both complete notes, explains why it cannot know which is newer, and offers clear choices to keep either version, keep both under a name you choose, or combine them yourself. Replacing one complete version always requires a separate confirmation.
- **Finish later without losing progress.** Leaving an unresolved note requires an explicit confirmation. Your local note remains in the vault; its Cloud comparison, last-synced version, and current draft stay in private app storage. The conflicted path waits while unrelated notes continue syncing, and reopening the queue restores the draft.
- **No task or vault pollution.** New conflicts never become numbered conflict files. While a note waits for your decision, its tasks are withheld from the app's own task surfaces: the Tasks view (list, calendar, and Kanban modes) and the calendar panel. Tools that read the vault straight from disk, such as MCP, the `zn` CLI, and the self-hosted server, still report that note's tasks as the local file has them. Existing conflict copies from older releases are left untouched and can be opened or moved to Trash explicitly.
- **Safe choices for every file type.** Text, binary, delete, move, and filename collisions use the same durable queue. Before saving, ZenNotes verifies both the local file and current Cloud revision. A local multi-file decision rolls back newly created destinations if a later write fails.

## 🧰 For contributors

- The shared coordinator now owns durable conflict-only snapshots, automatic line-based three-way merging, per-path sync pauses, stale-choice protection, and auto-next summaries. Desktop, iOS, and Android expose the same inspect, draft, and resolve bridge operations.
- ZenNotes Cloud adds an authorized historical-revision read so upgraded clients can recover the last agreed text when it is still retained. Older servers and expired revisions fall back safely to a two-version choice.
- Captioned real-app demo: `media/cloud-conflict-resolution-683.mp4` plus `media/cloud-conflict-resolution-683.vtt` (18 seconds, H.264, 1280×800). The clip uses the built Electron app against an isolated local Cloud fixture and was assembled with FFmpeg.
- Verification: the complete shared-app test and typecheck suites, desktop/web/server production builds, 621 Cloud tests, 30 iOS shell tests plus an Xcode simulator build, and 35 Android shell tests plus a Gradle debug APK build. Dependency audits report no known vulnerabilities on all four release branches.

---

Local-first and keyboard-first, as always.
