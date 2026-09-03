# ZenNotes 2.44.0: Twitter / X

## Launch thread draft

**1/3** — attach `media/cloud-conflict-resolution-683.mp4`

ZenNotes 2.44.0 makes a Cloud conflict understandable before you choose.

Compare the complete device and Cloud versions side by side, then keep either one, keep both under a name you choose, or merge the text yourself. No rename workaround. No surprise duplicate.

**2/3**

Before, Sync incomplete named the file but told you to edit or rename it. Editing hit the same conflict again. Renaming synced the new name, then restored the older Cloud copy at the original path—so you ended up with two notes and no explanation.

Now the outcome is explicit.

**3/3**

ZenNotes also checks that neither copy changed while the comparison was open. If it did, the resolution stops instead of overwriting a newer edit.

Thanks @uNyanda for the report and #683.

Free, open source, local-first Markdown notes.
https://zennotes.org

## Single-post alternative

ZenNotes 2.44.0 makes first-sync Cloud conflicts understandable: compare the complete device and Cloud versions, then keep either one, keep both under a name you choose, or merge the text yourself. No rename workaround or surprise duplicate. Thanks @uNyanda for #683. https://zennotes.org

## Notes

- Captioned clip: `media/cloud-conflict-resolution-683.mp4` plus `.vtt` (17.85 seconds, built Electron app, isolated local fixture).
- The shipped slice handles bootstrap conflicts, when a newly linked Cloud vault and the device already have different contents at the same path. #683 remains open for the broader queued and hunk-level resolution workflow.
