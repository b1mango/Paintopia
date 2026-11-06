from collections import deque
from pathlib import Path

from PIL import Image, ImageFilter


ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / "apps" / "web" / "public" / "media" / "1.png"
OUT_DIR = SOURCE.parent

OUTPUT_SIZES = (1024, 512, 256, 128, 64, 32)
PADDING = 40


def build_alpha() -> Image.Image:
    image = Image.open(SOURCE).convert("L")
    alpha = Image.new("L", image.size, 0)
    source = image.load()
    target = alpha.load()

    for y in range(image.height):
        for x in range(image.width):
            value = source[x, y]
            if value >= 232:
                target[x, y] = 255
            elif value >= 28:
                target[x, y] = round((value - 28) / 204 * 255)

    alpha = remove_tiny_components(alpha, min_area=18)
    bbox = alpha.getbbox()
    if bbox is None:
        raise RuntimeError("No icon pixels detected")

    left = max(0, bbox[0] - PADDING)
    top = max(0, bbox[1] - PADDING)
    right = min(alpha.width, bbox[2] + PADDING)
    bottom = min(alpha.height, bbox[3] + PADDING)
    alpha = alpha.crop((left, top, right, bottom))

    canvas_size = max(alpha.size)
    canvas = Image.new("L", (canvas_size, canvas_size), 0)
    canvas.paste(alpha, ((canvas_size - alpha.width) // 2, (canvas_size - alpha.height) // 2))
    alpha = canvas
    alpha = alpha.filter(ImageFilter.GaussianBlur(0.55))
    alpha = alpha.point(lambda value: 0 if value < 4 else min(255, round(value * 1.08)))
    return alpha


def remove_tiny_components(alpha: Image.Image, min_area: int) -> Image.Image:
    width, height = alpha.size
    pixels = alpha.load()
    visited: set[tuple[int, int]] = set()
    result = alpha.copy()
    result_pixels = result.load()

    for y in range(height):
        for x in range(width):
            if (x, y) in visited or pixels[x, y] == 0:
                continue

            component: list[tuple[int, int]] = []
            queue: deque[tuple[int, int]] = deque([(x, y)])
            visited.add((x, y))

            while queue:
                px, py = queue.popleft()
                component.append((px, py))
                for nx in range(max(0, px - 1), min(width, px + 2)):
                    for ny in range(max(0, py - 1), min(height, py + 2)):
                        if (nx, ny) not in visited and pixels[nx, ny] > 0:
                            visited.add((nx, ny))
                            queue.append((nx, ny))

            if len(component) < min_area:
                for px, py in component:
                    result_pixels[px, py] = 0

    return result


def render_icon(alpha: Image.Image, color: tuple[int, int, int, int], size: int) -> Image.Image:
    base = Image.new("RGBA", alpha.size, (0, 0, 0, 0))
    foreground = Image.new("RGBA", alpha.size, color)
    full = Image.composite(foreground, base, alpha)
    return full.resize((size, size), Image.Resampling.LANCZOS)


def main() -> None:
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    alpha = build_alpha()

    for size in OUTPUT_SIZES:
        render_icon(alpha, (0, 0, 0, 255), size).save(OUT_DIR / f"paintopia-icon-black-{size}.png")
        render_icon(alpha, (255, 255, 255, 255), size).save(OUT_DIR / f"paintopia-icon-white-{size}.png")

    print("created black and white raster icons from 1.png")


if __name__ == "__main__":
    main()
