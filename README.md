# Magik Prompt Preview

ComfyUI output node, category **Magik/Display**. Browse `(prompt, media)` pairs: a prompt text shown side by side with an image or video you associate with it, with a compact mode and a searchable, sortable prompt deck.

## Install

Clone or extract into `ComfyUI/custom_nodes/`, restart ComfyUI, and refresh the browser. Add **Magik Prompt Preview**. Uses NumPy and Pillow from your ComfyUI environment; no other dependencies.

```bash
git clone https://github.com/IA-gyz/comfyui-magik-prompt-preview.git
```

## Inputs

- **prompts** — `STRING`, multiline widget or input. Each list item is one prompt card; a pasted multi-line widget value is split into one card per line. Wire a list (e.g. from a text-file node) to load a whole deck at once.
- **images** — optional `IMAGE`. Batch index pairs with prompt index, so an N-image batch matches N prompts. Images are saved as temporary PNG previews (plus WebP thumbnails) under ComfyUI's temp directory, in `magik_prompt_preview/`, with the workflow prompt embedded in PNG metadata unless metadata is disabled.
- **media** — image or video file picked from ComfyUI's `input/` folder (including subfolders). Shown for cards that have no connected image. **Upload** drops a file into `input/magik_prompt_preview/` (extension allow-list, 1 GiB cap, atomic naming, path-traversal-safe) and selects it. Files are served through ComfyUI's native `/view?type=input`; videos play in a `<video>` element.

## Outputs

- **prompts** — `STRING` list: the prompts re-emitted in the deck order chosen in the UI (manual reorder, A–Z, favorites first, newest first). The order is written to the hidden `sort_order` widget and stored in workflow properties, so it applies from the next run and survives save/reload.

## Controls

- **◀ / ▶** (or `←` / `→`): navigate the deck. The `n/total` label shows the position within the current search filter.
- **Search box** (press `/`): case-insensitive substring filter over the prompt texts.
- **Sort dropdown**: `Manual` (use **⇤ / ⇥** to move the selected card through the deck), `A–Z`, `Favorites first`, `Newest first`. The chosen order drives the `prompts` output.
- **★** (or `f`): favorite the selected prompt; favorites persist in workflow properties.
- **Copy**: copy the selected prompt (clipboard API with a fallback for plain-HTTP installs).
- **Open**: open the selected media at full size in a new tab. Double-click the media for a fullscreen dialog with the prompt underneath.
- **⇄**: swap the media side (left/right) in side-by-side mode.
- **Compact / Split** (or `c`): compact mode shows only the image/video; click the media (or the ⓘ button, for videos) to overlay the prompt, click again to hide.
- **font / font_size**: typography of the prompt pane.

The filmstrip along the bottom shows one thumbnail per card (WebP thumbnail for connected images, file preview or ▶ badge for picked files, `Aa` for text-only cards); click to jump to a card.

Deck, order, favorites, filter, sort, compact mode and per-card overlay state are stored in workflow properties. Save the workflow to preserve them. Connected-image previews are temporary files; if the temp directory is cleared, re-run the workflow.

## Validation

Python compilation and JavaScript syntax checks passed in the build environment. Full integration, DOM layout and frontend-version compatibility require testing in ComfyUI.

The implementation uses the classic custom-node API and ComfyUI's `addDOMWidget` frontend facility.
