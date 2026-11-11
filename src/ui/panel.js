// The settings panel (press P). It is generated from the paramSchema each part
// of the game exports, so a new setting, or a different slime model with its
// own settings, appears here without any change to this file.

import { paramSchema as storySchema } from '../game/stories/index.js';
import { paramSchema as flowSchema, defaultParams as flowDefaults } from '../game/flow/index.js';

const format = (value, step) => (Number.isInteger(step) ? String(Math.round(value)) : Number(value).toFixed(3).replace(/\.?0+$/, ''));

function control(item, params, onChange) {
  const row = document.createElement('label');
  row.className = 'panel-row';
  if (item.help) row.title = item.help;
  const name = document.createElement('span');
  name.className = 'panel-name';
  name.textContent = item.label;
  let input;
  let readout = null;
  if (item.type === 'select') {
    input = document.createElement('select');
    for (const option of item.options) input.add(new Option(option, option));
  } else {
    input = document.createElement('input');
    input.type = { range: 'range', toggle: 'checkbox', color: 'color' }[item.type];
    if (item.type === 'range') {
      input.min = item.min;
      input.max = item.max;
      input.step = item.step;
      readout = document.createElement('output');
      readout.className = 'panel-value';
    }
  }
  const read = () => (item.type === 'toggle' ? input.checked : item.type === 'range' ? Number(input.value) : input.value);
  const show = (value) => {
    if (item.type === 'toggle') input.checked = Boolean(value);
    else input.value = value;
    if (readout) readout.textContent = format(value, item.step);
  };
  input.addEventListener('input', () => {
    params[item.key] = read();
    if (readout) readout.textContent = format(params[item.key], item.step);
    onChange?.(item.key, params[item.key]);
  });
  row.append(name, input);
  if (readout) row.append(readout);
  return { row, sync: () => show(params[item.key]), shown: () => read() };
}

export function createPanel(ctx, { model, bodyView, game }) {
  const root = document.createElement('aside');
  root.className = 'panel';
  root.setAttribute('aria-label', 'Settings');
  const controls = [];

  function group(title, schema, params, onChange) {
    const heading = document.createElement('h2');
    heading.textContent = title;
    root.append(heading);
    for (const section of schema) {
      const details = document.createElement('details');
      const summary = document.createElement('summary');
      summary.textContent = section.section;
      details.append(summary);
      for (const item of section.items) {
        const made = control(item, params, onChange);
        made.sync();
        controls.push({ ...made, item, params });
        details.append(made.row);
      }
      root.append(details);
    }
  }

  group(`Slime: ${model.id}`, model.paramSchema, model.params);
  group('Look', bodyView.paramSchema, bodyView.look);
  group('Stories', storySchema, game.stories.params);
  group('Ending', flowSchema, flowDefaults(), (key, value) => {
    if (key === 'endingTimeLimitEnabled') game.flow.setEndingEnabled(value);
    if (key === 'endingIdleEnabled') game.flow.setIdleEndingEnabled(value);
  });

  // Keyboard and pointer use of the panel must not reach the canvas beneath it.
  for (const type of ['pointerdown', 'pointerup', 'wheel', 'keydown']) root.addEventListener(type, (event) => event.stopPropagation());
  ctx.dom.app.append(root);

  let nextSyncMs = 0;
  return {
    /** Keep the controls in step with settings changed elsewhere (hotkeys, the console). */
    update(now) {
      if (ctx.dom.app.dataset.panelVisible !== 'true' || now < nextSyncMs) return;
      nextSyncMs = now + 250;
      for (const entry of controls) {
        if (document.activeElement !== entry.row.querySelector('input, select') && entry.shown() !== entry.params[entry.item.key]) entry.sync();
      }
    },
    dispose() { root.remove(); },
  };
}
