# Generated assets

Versioned outputs from the v2 asset tools are committed here once their formats freeze.

## Gold-wafer lookup

Run `npm run bake:goldlut` from `v2/` to regenerate the renderer lookup. The command prints the
full SHA-256 values needed by a future asset manifest; the first eight digits of the compressed
file hash are part of its name.

- File: `gold-lut.d489076d.bin.gz`
- Compressed SHA-256: `d489076d3715a8c0ddbad4e62887ee31c40dd4738f2e116dd3c8e3a47bc6a23b`
- Inflated SHA-256: `c77d3872956c1735733709acc620e9ea26822030575022e8f6f5edfdcae24bd7`
- Pixel payload SHA-256: `0ec04b7d6ed55209f26512ebf8270d9035291eab75c114c53979d2634f0f6f94`
- Inflated layout: 96-byte `GLUT` v1 header followed by 600×256×RGBA8 pixels

The header carries the coordinate mapping and pixel hash. Independent header and payload CRC32
values make accidental corruption fail before the renderer uploads the texture.
