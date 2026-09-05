# Tightening Fumadocs layout padding

The user's standing requirement for this skill: the docs layout should not waste horizontal space. Specifically:
1. **Outer edges** — the whole layout (sidebar + content + TOC) should extend close to both screen edges instead of capping at a centered, narrower column with big empty margins on wide screens.
2. **Mid-content padding** — the gaps around the article content (between sidebar and article, article and TOC) should also be tightened so the article itself gets more usable width.

## How Fumadocs' docs layout sizes itself

`DocsLayout` renders a CSS grid (`#nd-docs-layout`) with three columns: sidebar, content, TOC. The grid's total width is governed by the CSS variable `--fd-layout-width` (defaults to `97rem`), and individual column widths by `--fd-sidebar-width` / `--fd-toc-width`. On very wide monitors, the `97rem` cap is exactly why there's dead space on both outer edges — the grid stops growing and centers itself, leaving margins.

## Fix 1 — outer edges: override `--fd-layout-width`

In `app/global.css`, after importing Fumadocs' stylesheet, override the variable to let the grid use (nearly) the full viewport:

```css
:root {
  --fd-layout-width: 100%;
}
```

If `100%` behaves oddly with the grid's `minmax()` calculations in a given Fumadocs version, a very large fixed value works just as well and is safer (e.g. `140rem` or `1800px`) — pick whichever renders correctly when the user runs the dev server locally. Document both options in a comment in the CSS so the user can flip it if needed:

```css
:root {
  /* Option A: fill viewport */
  --fd-layout-width: 100%;
  /* Option B (fallback if Option A misbehaves): fixed large cap */
  /* --fd-layout-width: 140rem; */
}
```

## Fix 2 — remove/reduce the grid container's own outer padding

`DocsLayout` accepts `containerProps` to style the grid wrapper directly:

```tsx
<DocsLayout
  {...baseOptions()}
  tree={source.pageTree}
  containerProps={{ className: 'px-0' }}
>
```

Combine this with a small responsive padding directly on `#nd-docs-layout` in CSS (already included in the `global.css` template) so there's a little breathing room on small screens but near-zero on the outermost edges at larger widths:

```css
#nd-docs-layout {
  padding-inline: 0.5rem;
}
@media (min-width: 768px) {
  #nd-docs-layout {
    padding-inline: 1rem;
  }
}
```

## Fix 3 — mid-content padding (between sidebar/article/TOC)

This is the padding *inside* the content column — around the article's title/body, and the gutter next to the TOC. Two supported approaches, in order of preference:

**A. `DocsPage`/`DocsBody` className overrides (try first, least invasive):**
```tsx
<DocsPage toc={page.data.toc} full={page.data.full} article={{ className: 'max-w-none px-4 md:px-6' }}>
```
`DocsPage` and `DocsBody` accept `className`/style-related props in recent Fumadocs versions — check the installed version's typings (`node_modules/fumadocs-ui/dist/layouts/docs/page.d.ts` once the user has run `npm install`) to confirm the exact prop name available (it may be `article`, `containerProps`, or a `slots.container` override depending on version — see Fix B if none of these exist in the installed version).

**B. Eject the container slot via Fumadocs CLI (robust, version-proof — recommend this if A isn't available):**
Fumadocs ships a CLI to copy a component's source into the user's project so it can be edited directly, instead of guessing at prop names:
```bash
pnpm fumadocs add layouts/docs
```
This copies the layout's source into the project (e.g. `components/layout/docs/`). Once ejected, the user (or Claude in a follow-up session with the file present) can directly edit the Tailwind classes on the article/container wrapper (typically something like `max-w-*` and `px-*` utility classes on the element wrapping `children` inside the container component) to remove the max-width cap and shrink padding. This is the most reliable method because it edits real, visible source rather than relying on an internal prop name that varies by version.

**Note for this sandbox:** since there's no network access here, `pnpm fumadocs add ...` can't actually run in this environment. Include it as a documented next step for the user to run locally themselves if Fix A's props don't exist in their installed version — don't attempt to run it here.

## Summary of what this skill writes by default

Every scaffolded project includes, out of the box:
- `--fd-layout-width: 100%` in `global.css` (Fix 1)
- `containerProps={{ className: 'px-0' }}` on `DocsLayout` + small responsive `padding-inline` on `#nd-docs-layout` (Fix 2)
- A code comment in `app/docs/[[...slug]]/page.tsx` or `global.css` pointing to this reference's Fix 3 options, since the exact prop name for article-level padding depends on the Fumadocs version the user ends up installing.
