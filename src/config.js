// What kind of device this is and which URL flags are set. Decided once, at boot.

export const WORLD_SIZE = 9.6;   // length of the body's longest side, in world units

// How big the slime is relative to the body. 1 is the old game's proportion.
// It scales every distance that belongs to the slime and its food together:
// how far agents see and step, how far they are felt, how wide a new colony
// is, how far an oat's food reaches, how close oats may be, and how wide the
// pointer's push is. Smaller slime also crosses the body more slowly.
export const SLIME_SIZE = 0.5;

export const ASSETS = Object.freeze({
  body: 'assets/shen-v24-med.glb',
  sculptNormals: 'assets/shen-v24-normal-med.jpg',
  goldFilm: 'assets/gold-film-tensor.json',
});

/**
 * URL flags:
 *   ?dev         skip the start screen and intro; seed at once
 *   ?mobile=0|1  force the phone profile off or on
 *   ?field=N     atlas resolution of the slime (default 1536, phones 768)
 *   ?slime=id    which behavioural model to run (see src/slime/model.js)
 *   ?likephone   pretend the GPU lacks what iPhones lack (float blending, float filtering)
 */
export function readFlags(search = window.location.search) {
  const query = new URLSearchParams(search);
  return Object.freeze({
    dev: query.has('dev'),
    mobile: query.has('mobile') ? query.get('mobile') !== '0' : null,
    field: Number(query.get('field')) || null,
    slime: query.get('slime'),
    likePhone: query.has('likephone'),
  });
}

/** Phones get a smaller slime atlas and a lower pixel ratio: they run out of memory otherwise. */
export function deviceProfile(flags) {
  const smallTouchScreen = (window.matchMedia?.('(pointer: coarse)')?.matches ?? false)
    && Math.min(window.screen?.width ?? Infinity, window.screen?.height ?? Infinity) <= 820;
  const isMobile = flags.mobile ?? smallTouchScreen;
  return Object.freeze({
    isMobile,
    fieldSize: flags.field ?? (isMobile ? 768 : 1536),
    maxPixelRatio: isMobile ? 1.5 : 2,
  });
}
