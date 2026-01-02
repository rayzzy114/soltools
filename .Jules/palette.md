## 2024-05-23 - Icon-Only Buttons
**Learning:** Icon-only buttons (like refresh or settings icons) are a common accessibility gap in this codebase. They often lack `aria-label` or `title` attributes, making them invisible to screen readers and providing no hover feedback for mouse users.
**Action:** When spotting an icon-only button, always add both `aria-label` (for screen readers) and `title` (for mouse hover tooltips), unless a `Tooltip` component is already wrapping it.
