"""Magik Prompt Preview - browse (prompt, media) pairs side by side or compact."""
import json
import os
import re
import uuid

import numpy as np
from PIL import Image
from PIL.PngImagePlugin import PngInfo
import folder_paths
from comfy.cli_args import args

IMAGE_EXTS = {"png", "jpg", "jpeg", "webp", "gif", "bmp", "avif", "tiff"}
VIDEO_EXTS = {"mp4", "mov", "mkv", "webm", "avi", "m4v", "mpg", "mpeg", "wmv", "flv", "ogv", "ts"}
MEDIA_EXTS = IMAGE_EXTS | VIDEO_EXTS
TEMP_SUBFOLDER = "magik_prompt_preview"
UPLOAD_SUBFOLDER = "magik_prompt_preview"
MAX_UPLOAD_BYTES = 1024 * 1024 * 1024  # 1 GiB

FONTS = [
    "Sans-serif", "Serif", "Monospace", "System UI",
    "Noto Sans", "Noto Serif", "Noto Sans Mono",
    "DejaVu Sans", "DejaVu Serif", "DejaVu Sans Mono",
    "Liberation Sans", "Liberation Serif", "Liberation Mono",
    "Arial", "Georgia", "Verdana", "Courier New",
]


def media_kind_of(name):
    if not name or "." not in name:
        return "none"
    ext = name.rsplit(".", 1)[-1].lower()
    if ext in VIDEO_EXTS:
        return "video"
    if ext in IMAGE_EXTS:
        return "image"
    return "none"


def list_media_files():
    """Images and videos under ComfyUI's input/ directory, as relative paths."""
    root = folder_paths.get_input_directory()
    files = []
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = [d for d in dirnames if not d.startswith(".")]
        for filename in filenames:
            if "." not in filename:
                continue
            if filename.rsplit(".", 1)[-1].lower() not in MEDIA_EXTS:
                continue
            relative = os.path.relpath(os.path.join(dirpath, filename), root)
            files.append(relative.replace(os.sep, "/"))
    files.sort()
    return files or [""]


def _first(value, default=""):
    # INPUT_IS_LIST wraps widget values in a single-element list.
    if isinstance(value, (list, tuple)):
        return value[0] if value else default
    return value if value is not None else default


def _parse_order(sort_order, count):
    """JSON index array from the node UI; unknown or missing indices are appended."""
    seen = set()
    order = []
    try:
        raw = json.loads(sort_order) if isinstance(sort_order, str) and sort_order.strip() else []
        if isinstance(raw, list):
            for value in raw:
                if isinstance(value, int) and not isinstance(value, bool) and 0 <= value < count and value not in seen:
                    seen.add(value)
                    order.append(value)
    except (ValueError, TypeError):
        seen, order = set(), []
    for index in range(count):
        if index not in seen:
            order.append(index)
    return order


def _tensor_to_image(tensor):
    array = tensor.detach().cpu().float().numpy()
    array = np.nan_to_num(array, nan=0.0, posinf=1.0, neginf=0.0)
    array = (np.clip(array, 0, 1) * 255).astype(np.uint8)
    if array.shape[-1] == 1:
        array = array[..., 0]
    return Image.fromarray(array)


class MagikPromptPreview:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "prompts": ("STRING", {
                    "multiline": True, "default": "",
                    "tooltip": "Prompts to browse. Each list item is one card; a multi-line widget value is split into one card per line.",
                }),
                "media": (list_media_files(), {
                    "tooltip": "Image or video file from ComfyUI's input/ folder, shown next to prompts that have no connected image. Upload drops files into input/magik_prompt_preview/.",
                }),
                "mode": (["side_by_side", "compact"], {
                    "default": "side_by_side",
                    "tooltip": "Side by side shows prompt and media together; compact shows only the media and reveals the prompt on click.",
                }),
                "media_side": (["left", "right"], {
                    "default": "left",
                    "tooltip": "Which side of the node the media is displayed on in side-by-side mode.",
                }),
                "font": (FONTS, {"default": "Monospace"}),
                "font_size": ("INT", {"default": 14, "min": 6, "max": 64, "step": 1}),
            },
            "optional": {
                "images": ("IMAGE", {
                    "tooltip": "Optional image batch; batch index pairs with prompt index. Saved as temporary previews.",
                }),
                "sort_order": ("STRING", {
                    "default": "",
                    "tooltip": "JSON array of card indices in deck order, written by the node UI; reorders the prompts output.",
                }),
            },
            "hidden": {"prompt": "PROMPT", "extra_pnginfo": "EXTRA_PNGINFO"},
        }

    INPUT_IS_LIST = True
    RETURN_TYPES = ("STRING",)
    RETURN_NAMES = ("prompts",)
    OUTPUT_IS_LIST = (True,)
    FUNCTION = "preview"
    OUTPUT_NODE = True
    CATEGORY = "Magik/Display"
    DESCRIPTION = "Browse (prompt, media) pairs side by side or compact; search, favorite and sort prompts; emits them in the chosen order."

    def preview(self, prompts, media, mode, media_side, font, font_size,
                images=None, sort_order="", prompt=None, extra_pnginfo=None):
        texts = [str(t) for t in (prompts if isinstance(prompts, (list, tuple)) else [prompts])]
        if len(texts) == 1 and "\n" in texts[0]:
            # A pasted multi-line widget value becomes one card per line.
            texts = [line for line in texts[0].splitlines() if line.strip()] or [""]
        media_name = str(_first(media, ""))
        kind = media_kind_of(media_name)

        image_items = []
        if images is not None:
            batches = images if isinstance(images, (list, tuple)) else [images]
            for batch in batches:
                if batch is None:
                    continue
                if batch.ndim != 4 or batch.shape[-1] not in (1, 3, 4):
                    raise ValueError("Expected IMAGE batch [batch, height, width, channels] with 1, 3 or 4 channels.")
                if batch.shape[1] < 1 or batch.shape[2] < 1:
                    raise ValueError("Preview images must have positive width and height.")
                for index in range(batch.shape[0]):
                    image_items.append(batch[index])

        results = []
        if image_items:
            destination = os.path.join(folder_paths.get_temp_directory(), TEMP_SUBFOLDER)
            os.makedirs(destination, exist_ok=True)
            generation = uuid.uuid4().hex
            metadata = None
            if not args.disable_metadata:
                metadata = PngInfo()
                if prompt is not None:
                    metadata.add_text("prompt", json.dumps(prompt))
                for key, value in (extra_pnginfo or {}).items():
                    metadata.add_text(key, json.dumps(value))
            for index, tensor in enumerate(image_items):
                image = _tensor_to_image(tensor)
                filename = f"{generation}_{index:05}.png"
                thumbnail = f"{generation}_{index:05}_thumb.webp"
                image.save(os.path.join(destination, filename), pnginfo=metadata, compress_level=1)
                image.thumbnail((256, 256), Image.Resampling.LANCZOS)
                image.save(os.path.join(destination, thumbnail), format="WEBP", quality=80)
                results.append({"filename": filename, "thumbnail": thumbnail,
                                "subfolder": TEMP_SUBFOLDER, "type": "temp",
                                "width": int(tensor.shape[1]), "height": int(tensor.shape[0]),
                                "batch_index": index, "generation": generation})

        order = _parse_order(_first(sort_order, ""), len(texts))
        ordered = [texts[i] for i in order]
        return {"ui": {"magik_prompt_preview": {
                    "prompts": texts,
                    "images": results,
                    "media": media_name,
                    "media_kind": kind,
                }},
                "result": (ordered,)}


try:
    from aiohttp import web
    from server import PromptServer
except Exception:  # ComfyUI server not importable (e.g. unit tests)
    PromptServer = None


if PromptServer is not None:
    @PromptServer.instance.routes.get("/magik_prompt_preview/api/media")
    async def magik_prompt_preview_media(request):
        return web.json_response({"media": list_media_files()})

    @PromptServer.instance.routes.post("/magik_prompt_preview/api/upload")
    async def magik_prompt_preview_upload(request):
        """Save an uploaded image/video into input/magik_prompt_preview/ so the
        media dropdown lists it and /view?type=input serves it. Extension
        allow-list, streamed 1 GiB cap, path-traversal-safe atomic target."""
        reader = await request.multipart()
        field = None
        while True:
            part = await reader.next()
            if part is None:
                break
            if part.name == "file":
                field = part
                break
        if field is None or not field.filename:
            return web.json_response({"error": "file field is missing."}, status=400)
        base = os.path.basename(field.filename.replace("\\", "/"))
        stem, ext = os.path.splitext(base)
        ext = ext.lower().lstrip(".")
        if ext not in MEDIA_EXTS:
            return web.json_response({"error": f"file extension {ext!r} not allowed."}, status=400)
        stem = re.sub(r"[^A-Za-z0-9_\- ]", "_", stem).strip().strip(".") or "media"
        input_dir = os.path.realpath(folder_paths.get_input_directory())
        dest_dir = os.path.realpath(os.path.join(input_dir, UPLOAD_SUBFOLDER))
        os.makedirs(dest_dir, exist_ok=True)
        candidate = f"{stem}.{ext}"
        n = 1
        fd = None
        target = None
        while True:
            target = os.path.realpath(os.path.join(dest_dir, candidate))
            if not (target == dest_dir or target.startswith(dest_dir + os.sep)):
                return web.json_response({"error": "path traversal blocked."}, status=400)
            try:
                fd = os.open(target, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o644)
                break
            except FileExistsError:
                candidate = f"{stem}_{n}.{ext}"
                n += 1
                if n > 100000:
                    return web.json_response({"error": "could not find a free filename."}, status=500)
        total = 0
        try:
            with os.fdopen(fd, "wb") as out:
                while True:
                    chunk = await field.read_chunk(1024 * 1024)
                    if not chunk:
                        break
                    total += len(chunk)
                    if total > MAX_UPLOAD_BYTES:
                        raise ValueError("file exceeds the 1 GiB upload limit.")
                    out.write(chunk)
        except Exception as exc:
            try:
                os.unlink(target)
            except OSError:
                pass
            status = 413 if isinstance(exc, ValueError) else 500
            return web.json_response({"error": str(exc)}, status=status)
        return web.json_response({"media": f"{UPLOAD_SUBFOLDER}/{candidate}"})
