/** An 8-bit image whose pixels are palette indices. */
export interface IndexedImage {
  width: number;
  height: number;
  pixels: Uint8Array;
}

/** Where an image sits in an atlas, in pixels. */
export interface AtlasRegion {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Packs images into one atlas of the given width, shelf by shelf with the tallest first. Returns the
 * atlas and each image's region, in the order the images were given. Images of equal size are often
 * frames of one shape, so packing them together leaves little room unused.
 */
export function packAtlas(images: readonly IndexedImage[], width: number): {
  atlas: IndexedImage;
  regions: AtlasRegion[];
} {
  const order = images.map((_, index) => index).sort((a, b) => images[b].height - images[a].height || a - b);
  const regions: AtlasRegion[] = new Array(images.length);
  let x = 0;
  let y = 0;
  let shelf = 0;
  for (const index of order) {
    const image = images[index];
    if (image.width > width) throw new Error(`a ${image.width}-pixel-wide image does not fit a ${width}-pixel atlas`);
    if (x + image.width > width) {
      x = 0;
      y += shelf;
      shelf = 0;
    }
    regions[index] = { x, y, width: image.width, height: image.height };
    x += image.width;
    shelf = Math.max(shelf, image.height);
  }
  const height = Math.max(1, y + shelf);
  const pixels = new Uint8Array(width * height);
  images.forEach((image, index) => {
    const region = regions[index];
    for (let row = 0; row < image.height; row++) {
      const line = image.pixels.subarray(row * image.width, (row + 1) * image.width);
      pixels.set(line, (region.y + row) * width + region.x);
    }
  });
  return { atlas: { width, height, pixels }, regions };
}
