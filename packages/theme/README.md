# @moyu/theme — fixed Harness design tokens

MoYu consumes the DeepSeek Harness design tokens instead of defining a second
visual language. This package pins one snapshot and contains no runtime theme
logic; `apps/web` selects `light`, `dark` or `system` and toggles
`body[data-ds-dark-theme]`, which the token sheets use for the dark palette.

## Source

| Field | Value |
| --- | --- |
| Package | `@deepseek-ai/dsh-client-ui-theme` |
| Version | `0.2.1-rc.2` |
| Upstream repository | https://github.com/deepseek-ai/deepseek-harness |
| Upstream tag | `dsh-v0.2.1-rc.2` |
| Upstream commit | `687f282e8625c6b8d11ff58211a90524be2e4317` |
| Compiled artifact used | `lib/client.js` |
| Compiled artifact SHA-256 | `f9915fb53d5f156e75291e63be66c80e607a82bfd03c7d583e0a12ebef5a6cb8` |
| License | MIT (see `LICENSE`) |

The stylesheets are copied verbatim from the compiled artifact shipped with the
version MoYu's M0 baseline pinned. They are not hand-edited, so an upstream
upgrade must replace the snapshot and update the digests below.

## Files

| File | Original sheet | SHA-256 |
| --- | --- | --- |
| `src/styles/base.css` | `base.css` | `9e38aaa8c7857066e6d5950bd223e1a67b811961163a75d9f76d41d7da06e8ae` |
| `src/styles/corner-shape.css` | `corner-shape.css` | `4fb4a179766e332e86856c22ed51cf1c1aec91a241e99c3bb576163c8966a772` |
| `src/styles/design-platform.css` | `design-platform.css` | `ed5abcfa9f46bb2bfab93e7124f7727f0773f9dc38030492a4d07876db268848` |
| `src/styles/focus.css` | `focus.css` | `2d9a31f0de472ed83d232fdaaa0536a1d7bdc2c3b38940c3e4c80aefdd9a22a3` |
| `src/styles/gradient-shadow-text.css` | `gradient-shadow-text.css` | `f1b51007f400f508ff8bcc17601efd2d56b43e45afe655f7064da66e1b3716d0` |
| `src/styles/scrollbar.css` | `scrollbar.css` | `5926356b26bac11e26f4da9f5b1bac34d9d5d41c9e64f9a96fdf2ec73301e53c` |

These digests are the committed snapshot MoYu consumes; an upstream update must
replace the stylesheets and update this table and the artifact digest together.
