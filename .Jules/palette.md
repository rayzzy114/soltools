# Palette's Journal - Critical Learnings

## 2024-05-22 - Implicit Label Associations
**Learning:** Found multiple instances of separate Label and Input components without id/htmlFor association. While visually correct, this breaks screen reader accessibility and click-to-focus behavior.
**Action:** Always generate unique IDs for inputs and link them to labels using htmlFor, even for "simple" forms.
