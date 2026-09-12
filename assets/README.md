# Cartoon skin assets

These original raster assets were generated for SeeDoodle on 2026-09-10 with
Google Gemini `gemini-3.1-flash-image-preview` (the local `gemini-image` skill's
`flash` model). They use text prompts without third-party reference images.
The full-resolution generation outputs are kept outside the repository;
the game ships only the resized, optimized JPEGs listed below.

| File | Purpose |
| --- | --- |
| `toon-surface-v1.jpg` | Neutral, low-contrast plaster and painterly grain, tiled and tinted by the cartoon renderer on architecture and character materials. |
| `toon-preview-v2.jpg` | Revised landscape preview with a diverse three-person adult squad: a dark-skinned woman with curly tied-up hair in green, a medium-skinned androgynous adventurer with a short bob in blue, and a light-skinned man with close-cropped hair in orange. |

The preview was generated with the same Gemini model on 2026-09-10 by
editing an earlier generated preview. It keeps the setting and art direction
while varying the squad's gender presentation, skin tones, and hairstyles.

The 512 x 512 surface tile is derived from a generated multicolor plaster
texture: it is desaturated, high-pass filtered, reduced to subtle light-gray
contrast, and blended at opposite edges for repeat sampling. The 960 x 540
preview is cropped to 16:9. Both use optimized progressive JPEG encoding.

The preview is illustrative key art. In-game geometry, lighting, player colors,
and material tinting are implemented by the renderer.

## Times Square billboard atlas

`times-square-billboards-v2.jpg` is a 2048 x 2560 atlas containing sixteen square advertisements and one wide campaign.
Eight photographic compositions were generated on 2026-09-11 with Gemini
`gemini-3-pro-image-preview`, using the local `gemini-image` skill at 2K resolution.
The prompts requested adult fashion portraits, cola, an electric car, a theatrical lion,
a running shoe, perfume and a watch. These are generated illustrations, not photographs
of real campaigns. Typography and the remaining sign graphics were composed locally
with Pillow, DejaVu fonts and Lobster (https://github.com/google/fonts/tree/main/ofl/lobster).
No font download is required at runtime.

The row-major tile catalog is: NOIR fashion, Coca-Cola, ION electric car, The Lion King;
Nasdaq, TKTS, Chicago, Broadway/New York; M&M's, Levi's, Samsung, ABC News; NOIR menswear,
running shoe, Lumiere perfume, Aether watch. Familiar district names and storefront marks
provide location cues; these simplified illustrations do not reproduce current campaigns.
The source sheets and composition script are retained outside the served checkout in
`../deploy/times-square-v2-art/` relative to the repository root.

The square tiles occupy the first four rows; a 2048 x 512 fashion campaign fills the final row
for the Marriott podium screen without cropping faces. Each square tile has an eight-pixel extruded border to avoid neighboring artwork bleeding
through mipmaps. Billboard meshes share one texture and material; Classic Ink derives its
hatching from image luminance, while Sunlit Toon preserves the artwork colors. The game
loads this asset from its own server and keeps plain-color signs if the image is unavailable.

## Landmark map materials

`landmark-materials-v1.jpg` is a 2048 x 2048 original material sheet generated on 2026-09-11
with Gemini `gemini-3-pro-image-preview` via the local `gemini-image` skill at 2K.
The text-only prompt requests four orthographic, diffuse material quadrants: weathered grey
Great Wall brickwork, pale limestone, Lombard Street red brick paving, and close grass.
No reference photograph is embedded in this sheet. The original PNG and prompt output are
kept outside the served checkout in `../deploy/landmark-maps-art/`.

The game downloads one optimized JPEG, then extracts the four quadrants into separate
repeating textures with their own mipmaps. This prevents pale stone from bleeding into
distant grass at the edges of a shared atlas. Brick, stone, paving and grass remain lit by
the existing world lighting and shadows; failed or delayed image loads use stable procedural
fallback colors. Glazed roof tiles, lacquer, and stucco are code-generated surface finishes.
Street signs in Lombard Street are drawn locally to a shared canvas texture.

These surfaces are opt-in for the four landmark maps. Existing map and character materials
keep their prior rendering, and the Classic Ink skin remains available on all new maps.
