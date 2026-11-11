// The body as drawn: the gold body underneath, the slime film over it, both fed
// by the display field. This is the only place that knows how those three fit
// together; the frame loop just calls update() then lets the scene render.

import * as THREE from 'three';
import { paramSchema, defaultParams, DETAIL } from './look.params.js';
import { lightPositions, activeLights } from './lights.js';
import { createDisplayField } from './display-field.js';
import { createSlimeFilm } from './slime-film.js';
import { createGoldBody, buildGoldFilmLookup } from './gold-body.js';

// The slime's bump is measured over a slightly wider span when the display is
// blurred more, so the relief stays in proportion.
const BUMP_BASE_RADIUS_TEXELS = 1;
const BUMP_RADIUS_PER_SMOOTHING = 0.65;

/**
 * @param goldTensor     parsed assets/gold-film-tensor.json, or null to go without the gold body
 * @param sculptNormals  the sculpt's normal map texture, or null
 */
export function createBodyView({ gpu, scene, surface, profile, goldTensor, sculptNormals, diag }) {
  const look = defaultParams();
  const detail = profile.isMobile ? DETAIL.light : DETAIL.full;
  const lights = lightPositions(surface.worldSize);
  const hasSculptUvs = Boolean(surface.geometry.attributes.uv1);

  const display = createDisplayField({ gpu, surface, smoothingTaps: detail.smoothingTaps });
  const film = createSlimeFilm({ lightPositions: lights, fieldSize: surface.fieldSize, sculptNormals });
  surface.mesh.material.dispose();
  surface.mesh.material = film.material;
  scene.add(surface.mesh);

  let gold = null;
  if (goldTensor) {
    try {
      gold = createGoldBody({
        gpu, geometry: surface.geometry, filmLookup: buildGoldFilmLookup(goldTensor),
        lightPositions: lights, sculptNormals: hasSculptUvs ? sculptNormals : null,
      });
      gold.mesh.visible = false;
      scene.add(gold.mesh);
    } catch (error) {
      diag.log('gold-body', `unavailable: ${error.message}`);
    }
  }

  return {
    paramSchema,
    /** Live look settings. */
    look,
    display,

    /** Call once per frame before rendering. `model` is the SlimeModel. */
    update(model, camera, slimeChanged) {
      if (slimeChanged) display.markChanged();
      const goldShown = Boolean(gold) && look.useGoldBody && look.showGold && look.view === 'slime';
      display.update(model.thickness, look, model.thicknessMax, Boolean(gold) && look.useGoldBody);

      const rig = activeLights(look.useFaceLights);
      const u = film.material.uniforms;
      u.u_thickness.value = display.texture;
      u.u_thicknessMax.value = model.thicknessMax;
      u.u_sculptDetail.value = hasSculptUvs && sculptNormals?.image ? look.sculptDetail : 0;
      u.u_heightScale.value = look.surfaceHeight;
      u.u_bumpStrength.value = look.surfaceBump;
      u.u_bumpRadiusTexels.value = BUMP_BASE_RADIUS_TEXELS + Math.max(0, look.spatialSmoothing) * BUMP_RADIUS_PER_SMOOTHING;
      u.u_diagonalBumpTaps.value = detail.diagonalBumpTaps ? 1 : 0;
      u.u_iridescence.value = look.iridescenceStrength;
      u.u_filmMinNm.value = look.iridescenceMinThickness;
      u.u_filmMaxNm.value = look.iridescenceThickness;
      u.u_filmCurve.value = look.filmThicknessCurve;
      u.u_filmFollowsHeight.value = look.filmFollowsSlimeHeight ? 1 : 0;
      u.u_baseColor.value.set(look.slimeBaseColor);
      u.u_lightCount.value = rig.count;
      u.u_lightRadiance.value = look.lightBrightness * rig.radianceScale;
      u.u_cameraPos.value.copy(camera.position);
      u.u_outline.value = look.meshOutline ? 1 : 0;
      u.u_showRaw.value = look.view === 'thickness' ? 1 : 0;

      film.setOverGold(goldShown);
      surface.mesh.visible = look.showSlime || look.view !== 'slime';
      surface.mesh.renderOrder = goldShown ? 2 : 0;
      if (gold) {
        gold.mesh.visible = goldShown;
        if (goldShown) gold.sync(look, display.memoryTexture, model.thicknessMax, rig);
      }
    },

    /** The world was reset: forget the smoothed slime and where it has been. */
    reset() { display.reset(); },

    dispose() {
      scene.remove(surface.mesh);
      if (gold) scene.remove(gold.mesh);
      gold?.dispose();
      film.dispose();
      display.dispose();
    },
  };
}
