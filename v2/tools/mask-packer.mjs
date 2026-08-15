// Closed dilated masks, rather than chart bounding boxes, are the collision primitive. The
// bottom-left search skips ranges proven to collide with one occupied atlas bit.
export function packMasks(masks, fieldSize, { onPlace } = {}) {
  const wordsPerRow = Math.ceil(fieldSize / 32);
  const occupiedWords = new Uint32Array(fieldSize * wordsPerRow);
  const columnHeights = new Uint16Array(fieldSize);
  const placements = new Array(masks.length);
  const ordered = masks.map((mask, index) => ({ mask, index })).sort(compareMasks);
  let usingExactHoles = false;
  for (const { mask, index } of ordered) {
    let placement = usingExactHoles ? null : findSkylinePlacement(mask, columnHeights, fieldSize);
    if (!placement) {
      usingExactHoles = true;
      placement = findBottomLeft(mask, occupiedWords, fieldSize, wordsPerRow);
    }
    if (!placement) {
      throw new Error(
        `repack: mask packing failed after ${placements.filter(Boolean).length} charts; `
        + `chart ${mask.chart.id} is ${mask.width}x${mask.height}`,
      );
    }
    writeMask(mask.dilatedRows, placement.x, placement.y, occupiedWords, wordsPerRow);
    updateSkyline(mask, placement, columnHeights);
    placements[index] = placement;
    onPlace?.({ placedCount: placements.filter(Boolean).length, chartId: mask.chart.id, usingExactHoles });
  }
  return {
    placements,
    occupiedWords,
    occupiedCount: countBits(occupiedWords),
    occupancyRatio: countBits(occupiedWords) / (fieldSize ** 2),
  };
}

function findSkylinePlacement(mask, columnHeights, fieldSize) {
  const profile = columnProfile(mask);
  let best = null;
  for (let x = 0; x <= fieldSize - mask.width; x += 1) {
    let y = 0;
    for (let localX = 0; localX < profile.bottom.length; localX += 1) {
      if (profile.bottom[localX] < 0) continue;
      y = Math.max(y, columnHeights[x + localX] - profile.bottom[localX]);
    }
    let top = 0;
    for (let localX = 0; localX < profile.top.length; localX += 1) {
      if (profile.top[localX] >= 0) top = Math.max(top, y + profile.top[localX] + 1);
    }
    if (top > fieldSize) continue;
    if (!best || top < best.top || (top === best.top && (y < best.y || (y === best.y && x < best.x)))) {
      best = { x, y, top };
    }
  }
  return best && { x: best.x, y: best.y };
}

function updateSkyline(mask, placement, columnHeights) {
  const { top } = columnProfile(mask);
  for (let localX = 0; localX < top.length; localX += 1) {
    if (top[localX] >= 0) {
      columnHeights[placement.x + localX] = Math.max(
        columnHeights[placement.x + localX],
        placement.y + top[localX] + 1,
      );
    }
  }
}

function columnProfile(mask) {
  if (mask.columnProfile) return mask.columnProfile;
  const bottom = new Int32Array(mask.width).fill(-1);
  const top = new Int32Array(mask.width).fill(-1);
  for (let y = 0; y < mask.dilatedRows.length; y += 1) {
    for (const [start, end] of mask.dilatedRows[y]) {
      for (let x = start; x <= end; x += 1) {
        if (bottom[x] < 0) bottom[x] = y;
        top[x] = y;
      }
    }
  }
  mask.columnProfile = { bottom, top };
  return mask.columnProfile;
}

export function masksIntersectAt(maskRows, x, y, occupiedWords, wordsPerRow) {
  return collisionAdvance(maskRows, x, y, occupiedWords, wordsPerRow) !== null;
}

export function packMasksNearOriginal(masks, fieldSize, { maxRadius = fieldSize, onPlace } = {}) {
  const wordsPerRow = Math.ceil(fieldSize / 32);
  const occupiedWords = new Uint32Array(fieldSize * wordsPerRow);
  const placements = new Array(masks.length);
  const ordered = masks.map((mask, index) => ({ mask, index })).sort(compareMasks);
  for (const { mask, index } of ordered) {
    const centerU = (mask.chart.uvBounds[0] + mask.chart.uvBounds[2]) * 0.5;
    const centerV = (mask.chart.uvBounds[1] + mask.chart.uvBounds[3]) * 0.5;
    const preferred = {
      x: Math.round(mask.baseTexelX + (1 - mask.chartScale) * centerU * fieldSize),
      y: Math.round(mask.baseTexelY + (1 - mask.chartScale) * centerV * fieldSize),
    };
    preferred.x = clamp(preferred.x, 0, fieldSize - mask.width);
    preferred.y = clamp(preferred.y, 0, fieldSize - mask.height);
    const placement = findNearest(mask, preferred, occupiedWords, fieldSize, wordsPerRow, maxRadius);
    if (!placement) {
      throw new Error(`repack: original-layout search failed after ${placements.filter(Boolean).length} charts`);
    }
    writeMask(mask.dilatedRows, placement.x, placement.y, occupiedWords, wordsPerRow);
    placements[index] = placement;
    onPlace?.({ placedCount: placements.filter(Boolean).length, chartId: mask.chart.id, placement });
  }
  const occupiedCount = countBits(occupiedWords);
  return { placements, occupiedWords, occupiedCount, occupancyRatio: occupiedCount / (fieldSize ** 2) };
}

function findNearest(mask, preferred, occupiedWords, fieldSize, wordsPerRow, radiusLimit) {
  const maxX = fieldSize - mask.width;
  const maxY = fieldSize - mask.height;
  const maxRadius = Math.min(radiusLimit, Math.max(fieldSize, Math.abs(preferred.x), Math.abs(preferred.y)));
  for (let radius = 0; radius <= maxRadius; radius += 1) {
    for (let offset = -radius; offset <= radius; offset += 1) {
      const candidates = radius === 0 ? [[preferred.x, preferred.y]] : [
        [preferred.x + offset, preferred.y - radius],
        [preferred.x + offset, preferred.y + radius],
        [preferred.x - radius, preferred.y + offset],
        [preferred.x + radius, preferred.y + offset],
      ];
      for (const [x, y] of candidates) {
        if (x < 0 || y < 0 || x > maxX || y > maxY) continue;
        if (!masksIntersectAt(mask.dilatedRows, x, y, occupiedWords, wordsPerRow)) return { x, y };
      }
    }
  }
  return null;
}

function findBottomLeft(mask, occupiedWords, fieldSize, wordsPerRow) {
  if (mask.width > fieldSize || mask.height > fieldSize) return null;
  const maxX = fieldSize - mask.width;
  const maxY = fieldSize - mask.height;
  for (let y = 0; y <= maxY; y += 1) {
    let x = 0;
    while (x <= maxX) {
      const nextX = collisionAdvance(mask.dilatedRows, x, y, occupiedWords, wordsPerRow);
      if (nextX === null) return { x, y };
      x = Math.max(x + 1, nextX);
    }
  }
  return null;
}

function collisionAdvance(rows, x, y, occupiedWords, wordsPerRow) {
  let advance = null;
  for (let localY = 0; localY < rows.length; localY += 1) {
    for (const [start, end] of rows[localY]) {
      const first = firstOccupiedBit(
        occupiedWords,
        (y + localY) * wordsPerRow,
        x + start,
        x + end,
      );
      if (first !== -1) advance = Math.max(advance ?? 0, first - start + 1);
    }
  }
  return advance;
}

function firstOccupiedBit(words, rowOffset, start, end) {
  const firstWord = start >>> 5;
  const lastWord = end >>> 5;
  for (let wordIndex = firstWord; wordIndex <= lastWord; wordIndex += 1) {
    const lowBit = wordIndex === firstWord ? start & 31 : 0;
    const highBit = wordIndex === lastWord ? end & 31 : 31;
    const lowMask = (0xffffffff << lowBit) >>> 0;
    const highMask = highBit === 31 ? 0xffffffff : (2 ** (highBit + 1) - 1) >>> 0;
    const matching = words[rowOffset + wordIndex] & lowMask & highMask;
    if (matching) return wordIndex * 32 + trailingZeroCount(matching);
  }
  return -1;
}

function writeMask(rows, x, y, occupiedWords, wordsPerRow) {
  for (let localY = 0; localY < rows.length; localY += 1) {
    const rowOffset = (y + localY) * wordsPerRow;
    for (const [start, end] of rows[localY]) setBitRange(occupiedWords, rowOffset, x + start, x + end);
  }
}

function setBitRange(words, rowOffset, start, end) {
  const firstWord = start >>> 5;
  const lastWord = end >>> 5;
  for (let wordIndex = firstWord; wordIndex <= lastWord; wordIndex += 1) {
    const lowBit = wordIndex === firstWord ? start & 31 : 0;
    const highBit = wordIndex === lastWord ? end & 31 : 31;
    const lowMask = (0xffffffff << lowBit) >>> 0;
    const highMask = highBit === 31 ? 0xffffffff : (2 ** (highBit + 1) - 1) >>> 0;
    words[rowOffset + wordIndex] |= lowMask & highMask;
  }
}

function compareMasks(left, right) {
  return right.mask.dilatedCount - left.mask.dilatedCount
    || right.mask.height - left.mask.height
    || right.mask.width - left.mask.width
    || left.mask.chart.id - right.mask.chart.id;
}

function trailingZeroCount(value) {
  return 31 - Math.clz32(value & -value);
}

function countBits(words) {
  let count = 0;
  for (let value of words) {
    value -= (value >>> 1) & 0x55555555;
    value = (value & 0x33333333) + ((value >>> 2) & 0x33333333);
    count += (((value + (value >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24;
  }
  return count;
}

function clamp(value, minimum, maximum) { return Math.max(minimum, Math.min(maximum, value)); }
