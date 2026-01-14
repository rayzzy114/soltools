## 2024-05-23 - Micro-interactions in List Views
**Learning:** Users often need to copy addresses from dense lists. Adding a small, dedicated copy button next to truncated addresses significantly improves usability compared to selecting text or opening a detail view.
**Action:** When displaying truncated identifiers (addresses, hashes) in lists, always include an inline "Copy" button with `aria-label`.

## 2024-05-23 - Accessibility in Data Grids
**Learning:** Checkboxes in data grids (like "Select All" or row selection) often lack context for screen readers.
**Action:** Always add `aria-label` to checkboxes in lists, referencing the row content (e.g., "Select wallet 1") or the global action ("Select all items").

## 2024-05-24 - Form Label Associations in Dialogs
**Learning:** Settings dialogs using `Label` and `Input` components often miss the explicit `htmlFor` and `id` connection, breaking screen reader accessibility.
**Action:** When creating or editing form inputs in Dialogs, strictly enforce `id` on Inputs and `htmlFor` on Labels.
