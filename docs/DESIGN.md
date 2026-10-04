# Halcyon — design

Benchmark: Dan Greenheck's TIDEWATER (x.com/dangreenheck/status/2102878170089169235, a three.js ocean world shown in a
two-minute capture). Studied frame by frame from the capture, not reused: this is an original implementation on
three.js r186 / WebGL2. Models are Sketchfab scans under CC BY 4.0 and CC0, surfaces are Poly Haven CC0 and the
mountain is USGS lidar. All are listed in [CREDITS.md](../CREDITS.md) and in the About panel.

## What the benchmark does well (keep the bar)
- FFT ocean with breaking shore waves, swash on the sand, foam, glitter and a believable horizon.
- A lived-in island: beach, long pier with lanterns, beach houses, boats, palms and a forested hill.
- Moves between walking, driving a boat, diving (a humpback over a rocky floor) and a free camera.
- Time-of-day panel; the sunset over the pier is its strongest frame.

## Where it stops (our upgrade axes)
| Gap in benchmark | Halcyon |
|---|---|
| One island beside open sea | A whole atoll: barrier reef ring, a pass, five motus, lagoon, and Mount Halcyon: a real peak (Ōlomana, O'ahu) from USGS lidar |
| Rocks and blobs under water | 370 k instanced colonies of six scanned coral species, lobed knolls with lone heads |
| Few animals | Scanned reef fish in 12 schools; whales that blow and breach, dolphins, turtles, rays, sharks, gulls, crabs |
| Simple low-poly props | Detailed Sketchfab houses, huts, kiosks and a dhow, each with per-placement LOD |
| Manual time only | A 36-minute day with sun and moon for a tropical latitude, weather that turns on its own, night bioluminescence |
| Silent or looped audio | Procedural sound: surf by distance to the break, wind, birds and crickets, rain, whale song under water |
| Desktop only | Touch controls and a mobile asset tier |

Performance is the first gate: 60 fps headed at 1920x1080@2x, measured p50/p95/p99 over 15 s+ dwells.

## World (metres; water y = 0; north is -z)
Main island of five lobes with three bays; the barrier reef is an ellipse 1300 x 1110 m around it, broken by Kingfisher
Pass. Places: Halcyon Harbour (pier), Saltwater Village, overwater bungalows, the beach bar, Mount Halcyon and its lookout, the Inner Lagoon,
Pass Light, Palm Cay, the Drop-off. All shapes are in `src/world/layout.js`; heights come from one GPU heightfield
(3600 m, 2048 texels) read back once for walking, placement and buoyancy.

## Systems
- Frame: sky + clouds -> shadow -> opaque (MSAA HDR) -> resolve with depth -> water -> effects -> post (`pipeline.js`).
- Ocean: three FFT cascades (256^2), CDLOD grid, shore waves from a jump-flood coast field, ripple sim for wakes.
  Refraction absorbs along the depth of what each pixel actually shows, so stepped beds (knoll edges) stay clean.
- Sky: single-scattering atmosphere, ray-marched cumulus at half resolution with reprojection, cirrus, moon, stars.
- Vegetation: 24 species from photoreal scans (`scripts/flora.mjs`: per-species atlases, root balls sunk, trunks
  culled below ground), full geometry near with dithered LOD, hemi-octahedral impostors far; the understory shrinks out.
- Ground: layered by the vegetation map, not by height alone: beach, sandy soil behind it, kept grass round the village,
  rank grass and scrub beyond and up the slopes, leaf litter only under closed canopy; steep banks triplanar. Grass blades
  carry a normal attribute (without one three.js shades them flat, from face normals).
- Mount Halcyon (`scripts/massif.mjs`, `massif.js`): Ōlomana from the USGS 3DEP 1 m lidar DEM (its western foot from the
  10 m DEM), scaled 0.68 and turned so its single-pyramid face looks at the harbour. Baked onto the heightfield's own texels
  and added over the island's plain in the generator, so terrain, shadows, the vegetation map and walking all share it.
  The village keeps its flat lot; the lookout is a levelled shelf on the southern shoulder, reached by switchbacks routed
  over the relief. Far away, the ground between drawn crowns is shaded as the shade under a closed canopy.
- Light: a sunlit ground bounce in the ambient term (shade under eaves and canopies is warm, not blue); half-resolution
  GTAO that occludes only the sky and bounce share of each pixel, so sunlit faces keep their contrast (desktop only).
- Coral: per-colony LOD (4 levels), per-colony frustum culling, cells sorted near to far, ellipsoid diver collision.
- Fish: vertex-shader schools; each fish picks its LOD on the CPU by replaying the shader's path.
- Post: bloom, sun shafts, ACES, grade, underwater light, lens droplets, grain, sharpen.

## Assets (`scripts/models.mjs`)
- Start from the Sketchfab `gltf` archive (the `glb` archive is capped at 1K textures), packed into
  `.cache/sf_full/<src>.glb` with `gltf-transform copy`; `<src>` is the name in the script's table.
- Simplify with meshopt `simplifyWithAttributes` + `Prune` only, so collapses stay inside UV islands; `Permissive`
  and sloppy only for far levels. Thin-branch scans keep LOD0 near the raw count.
- Textures: KTX2. Far maps (ETC1S colour, UASTC normal) ship inside the `.glb`; full UASTC maps live in `hd/` and
  stream in by distance. Map sizes come from texel density, then halve while a magnified half map stays >= 42 dB.
- Mobile gets `.m.glb` (half geometry, ETC1S only, no HD streaming).

## Smoothness
- Boot warm-up: `compileAsync` on the real render target, then `initTexture` for every map, so no first-use hitch.
- HD streaming: maps upload over several frames (4K block rows ~2 MB a frame) before the swap.
- Governor: render scale steps down on p75 > 19.5 ms; a trickle of misses gets a trial step that reverts unless it
  helps; probing back up is held off with a doubling back-off.

## Measured (Apple Silicon, Chrome, 1920x1080@2x headed, governed)
From `scripts/perf.mjs`: 30 s dwells, with no other GPU or heavy process running. Frame times are in ms. The scale
column is the render scale the governor settled on.

| View | p50 | p95 | p99 | frames over 20 ms | scale |
|---|---|---|---|---|---|
| Village walk | 16.7 | 18.6 | 31.4 | 1.1% | 0.65 |
| Peak approach | 16.7 | 18.7 | 33.3 | 1.7% | 0.56 |
| Aerial orbit | 16.7 | 18.6 | 18.7 | 0.1% | 0.64 |
| Forest walk | 16.7 | 18.6 | 18.7 | 0.5% | 0.64 |
| Reef glide | 16.7 | 18.7 | 33.4 | 3.3% | 0.80 |

## Deploy
`dist` is a static site, so any static host works; serve `.ktx2` as `image/ktx2` and `.wasm` as `application/wasm`.
The live demo uses `deploy/deploy.sh`, which:
- builds the site;
- rsyncs `dist` to `/opt/halcyon/releases/<stamp>` and points `current` at it;
- recreates a Caddy container, using `deploy/compose.yaml` and `deploy/Caddyfile`, behind a shared gateway (`deploy/gateway.caddy`).

The target host and key come from `deploy/local.sh`, which git ignores.
