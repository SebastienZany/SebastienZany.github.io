# Game

The U1 DOM lane is live at `../../panel.html` and does not import the simulator or GPU runtime.

- `panel-controls.js` adds labels, grouping, help, and display formatting to the numeric source of
  truth in `shared/params.js`.
- `panel-model.js` owns preset application and custom-selection state.
- `panel.js` renders the controls and writes patches through a provider with `getParams()` and
  `setParams(patch, context)` (or `setParam`). A provider may also expose `getCameraPose()`.
- `stats.js` reads free counters and opt-in readbacks through `readStats(request)`. The request says
  whether readback is enabled and currently permitted under the frame-load gate.
- `hotkeys.js` is the pure P/S/M/1/2/3 router and triple-tap state machine.

The panel command interface names its hooks directly: `togglePause`, `reset`, `resetCamera`,
`seed`, `initialOat`, `togglePanels`, `skipIntro`, `toggleStories`, `toggleSlime`,
`toggleGoldBody`, `toggleAgentDots`, and `copyCameraPose`. M6 supplies the production providers.
