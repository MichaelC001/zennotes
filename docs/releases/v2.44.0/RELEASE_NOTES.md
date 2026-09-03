ZenNotes 2.44.0: Cloud conflicts can be compared and resolved in place

> When the first sync finds a note with the same filename on this device and in Cloud but different contents, ZenNotes now shows both versions and lets you choose the result. Keep the device copy, use Cloud, keep both under an explicit filename, or merge the text yourself—without renaming a note just to make sync continue.

## ✨ New

- **Compare and resolve a first-sync Cloud conflict.** (#683, reported by @uNyanda) The Sync incomplete card already named the local file, but its advice still left the user to solve the conflict through the filesystem: edit or rename one copy and sync again. Editing did not make either version authoritative, so sync stopped on the same conflict. Renaming did let sync continue, but Cloud then restored its older copy at the original path, leaving both files in the vault without explaining why. A conflicting file now has **Compare & resolve**. It opens the complete local and Cloud text side by side and offers four explicit outcomes: **Keep this device’s version** uploads the local file at its existing path; **Use Cloud version** replaces the local file; **Keep both…** asks where to put the device copy before restoring Cloud at the original path; and **Merge manually…** opens an editable result and saves that text as the agreed version. **Resolve later** closes the comparison without changing either copy. After a choice, ZenNotes runs sync again and returns the vault to **Everything is up to date** when no conflicts remain.

- **A stale choice cannot overwrite a newer edit.** ZenNotes reloads the Cloud manifest and scans the local vault before applying a resolution. If either version changed after the comparison opened, the action stops and asks for a fresh sync. Cloud must acknowledge an upload before the conflict is treated as resolved, and the follow-up sync still pulls other Cloud-only files instead of prematurely adopting the manifest. Text previews are limited to 256 KB; binary and oversized files can still be kept from either side, but are not rendered as text.

## 🧰 For contributors

- The resolver is a thin UI over new bridge operations for reading and resolving a bootstrap conflict. `CloudSyncCoordinator` owns the freshness checks and remote mutation, while each filesystem adapter applies the selected local result. The Electron implementation performs the keep-both move transactionally: if restoring the Cloud version fails, it moves the device file back.
- This release covers bootstrap conflicts—the no-baseline case where a newly linked vault already contains the same path on both sides. The existing post-link revision-conflict copy flow is unchanged; #683 remains the umbrella for a queued, hunk-level conflict workflow across those conflicts.
- Captioned demo: `media/cloud-conflict-resolution-683.mp4` with `media/cloud-conflict-resolution-683.vtt` (17.85 seconds). It uses the built Electron app against an isolated vault and local Cloud fixture, keeps the device version, and ends on a clean sync with one note.
- Verification: desktop build, workspace typecheck, and the focused desktop, app-core, and shared-domain Cloud sync suites pass. The demo MP4 also decodes cleanly as H.264 at 1280×800.

---

Local-first and keyboard-first, as always.
