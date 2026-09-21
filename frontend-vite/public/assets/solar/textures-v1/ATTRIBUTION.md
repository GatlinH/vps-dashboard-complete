# Texture Attribution

## Source

All planetary and lunar textures in this directory (`textures-v1`) originate from
**Solar System Scope (INOVE sp. z o.o.)**.

- Source: https://www.solarsystemscope.com/textures/
- Individual asset download URLs are recorded per-texture in `manifest.json`
  under each entry's `source_url` field.

## License

These textures are distributed under the **Creative Commons Attribution 4.0
International License (CC BY 4.0)**.

- License deed: https://creativecommons.org/licenses/by/4.0/
- Full legal code: https://creativecommons.org/licenses/by/4.0/legalcode

Under CC BY 4.0 you are free to share and adapt the material for any purpose,
including commercially, provided you give appropriate credit, link to the
license, and indicate whether changes were made.

## Required Attribution Statement

> Textures by Solar System Scope (CC BY 4.0), color-adjusted, based on NASA data

This statement is also embedded in `manifest.json` at both the top level
(`attribution_statement`) and per texture (`attribution`).

## Processing / Modifications Disclosure

Per CC BY 4.0, modifications must be indicated. The following processing has been
applied and is disclosed here and in the per-tier `processing` field of
`manifest.json`:

- **Upstream processing (by Solar System Scope):** The original textures were
  color-adjusted and, where source coverage was incomplete, had terrain/surface
  detail filled in by the author, based on publicly available NASA imagery and
  data. This is the publisher's own disclosed derivation from NASA source data.
- **Desktop tier:** Unmodified 2K (2048x1024, ring 2048x125) original source files.
- **Mobile tier:** Downsampled locally with ImageMagick `convert`:
  - JPEG bodies: `convert <in>.jpg -resize 1024x512 -quality 82 <name>-1k.jpg`
  - Saturn ring PNG: `convert 2k_saturn_ring_alpha.png -resize 1024x64 2k_saturn_ring_alpha-1k.png`

No other edits (recoloring, compositing, retouching) were performed locally.

## Assets

The 11 assets covered by this attribution (each in a desktop and a mobile tier):
Mercury, Venus, Earth (daymap), Earth clouds, Moon, Mars, Jupiter, Saturn,
Saturn ring (alpha), Uranus, Neptune.

See `manifest.json` for exact filenames, SHA256 digests, byte sizes, and
dimensions of every tier.
