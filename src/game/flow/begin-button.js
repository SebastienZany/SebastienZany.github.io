// The Begin button's look: a hairline box that fills with white on hover and
// blooms with a pale green glow when clicked. Drawn from script every frame
// because both animations are timed (the click glow swells exactly until the
// click sound's peak), which CSS :hover cannot do.

import { clamp01, smoothUnit } from './easing.js';

// `getPress()` -> { introRequested, clickedAtMs, fadeOutAtMs } tells the button
// whether Begin has been pressed and when its fade-out starts (0 = not yet).
export function createBeginButton(button, config, getPress) {
  // "mix" is how hovered the button looks: 0 = resting outline, 1 = filled.
  const hover = { startedAtMs: 0, from: 0, to: 0, mix: 0 };

  function draw(now) {
    const press = getPress();
    const clickedAtMs = press.clickedAtMs;
    const fadeOutAtMs = press.fadeOutAtMs;
    // A real click leaves a gap between the click and the fade-out (the wait
    // for the click sound's peak); a skip does not, and gets no glow.
    const hasClickGlow = press.introRequested && clickedAtMs > 0 && fadeOutAtMs > clickedAtMs;
    const fadeOutStarted = fadeOutAtMs > 0 && now >= fadeOutAtMs;

    let glow = 0;
    let mix = fadeOutStarted ? 1 : 0;
    if (hasClickGlow) {
      const rise = smoothUnit((now - clickedAtMs) / Math.max(1, fadeOutAtMs - clickedAtMs));
      const decay = fadeOutStarted
        ? 1 - smoothUnit((now - fadeOutAtMs) / config.fadeOutMs)
        : 1;
      glow = clamp01(rise * decay);
      mix = Math.max(hover.mix, config.clickFillFloor + (1 - config.clickFillFloor) * rise);
    } else if (!fadeOutStarted) {
      const t = smoothUnit((now - hover.startedAtMs) / config.hoverFadeMs);
      mix = hover.from + (hover.to - hover.from) * t;
    }
    mix = clamp01(mix);
    hover.mix = mix;

    const glowAlpha = hasClickGlow
      ? config.clickGlowAlphaBase + glow * config.clickGlowAlphaGain
      : mix * config.hoverGlowAlpha;
    const glowRadiusPx = hasClickGlow
      ? config.clickGlowRadiusBasePx + glow * config.clickGlowRadiusGainPx
      : mix * config.hoverGlowRadiusPx;
    const insetAlpha = hasClickGlow
      ? config.clickInsetAlphaBase + glow * config.clickInsetAlphaGain
      : mix * config.hoverInsetAlpha;
    const borderAlpha = config.borderAlphaBase + config.borderAlphaHoverGain * mix;
    const textLevel = Math.round(255 * (1 - mix)); // white text on clear, black on white

    const style = button.style;
    style.backgroundColor = `rgba(255, 255, 255, ${mix.toFixed(3)})`;
    style.borderColor = `rgba(255, 255, 255, ${borderAlpha.toFixed(3)})`;
    style.boxShadow = glowAlpha > 0.001
      ? `0 0 ${glowRadiusPx.toFixed(1)}px rgba(${config.glowRgb}, ${glowAlpha.toFixed(3)}), ` +
        `inset 0 0 ${(glowRadiusPx * config.insetRadiusFactor).toFixed(1)}px rgba(255, 255, 255, ${insetAlpha.toFixed(3)})`
      : 'none';
    style.color = `rgb(${textLevel}, ${textLevel}, ${textLevel})`;
  }

  // Ease towards `target` (0 or 1) from wherever the button is now, or jump
  // there when `immediate` (a press should not wait for a hover fade).
  function setHoverTarget(target, now, immediate = false) {
    if (!immediate) draw(now); // settle hover.mix at this instant before re-aiming
    const value = clamp01(target);
    hover.startedAtMs = now;
    hover.from = immediate ? value : hover.mix;
    hover.to = value;
    hover.mix = hover.from;
    draw(now);
  }

  return { draw, setHoverTarget };
}
