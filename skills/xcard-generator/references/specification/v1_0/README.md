# A2UI v1.0 schemas

This directory contains the wire-level v1.0 envelope schemas used by the
runtime. v1.0 is the only protocol version the renderer accepts; a message
whose `version` field is anything else is rejected with `UNSUPPORTED_VERSION`.

The v1.0 protocol uses the agent/renderer terminology. A catalog is resolved
from the component or function call `catalogId`, then the surface default
catalog. `updateDataModel.value` is required; JSON `null` deletes the selected
path.

## Yuanbao catalog

`catalogs/basic/catalog.json` mirrors the upstream A2UI v1.0 basic catalog.
Yuanbao-specific rendering is declared separately in
`catalogs/yuanbao/catalog.json` with catalog ID
`https://a2ui.org/specification/v1_0/catalogs/basic/catalog.json`.

The first phase adds only these properties:

- `Text.maxLines` and
  `Text.style.foregroundColor/fontWeight/textDecoration`
- `Button.style.size/backgroundColor/cornerRadius`
- `Row/Column/List.style.gap/padding`
- `Card.style.gap/padding/backgroundColor/cornerRadius`

Color values are local token names. Gap and padding are non-negative dp
numbers. Corner radii accept a non-negative dp number or a local shape token
name. Unknown properties fail component schema validation; raw colors, absolute
positioning, shadows, gradients and transforms are intentionally not supported.
