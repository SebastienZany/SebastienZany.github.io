# Vendored CPU libraries

These modules are committed because the shipped page has no build step or CDN dependency. They
are CPU-only in v2; no three.js renderer may be instantiated.

## three 0.170.0

- Tarball: https://registry.npmjs.org/three/-/three-0.170.0.tgz
- npm integrity: `sha512-FQK+LEpYc0fBD+J8g6oSEyyNzjp+Q7Ks1C568WWaoMRLW+TkNNWmenWeGgJjV105Gd+p/2ql1ZcjYvNiPZBhuQ==`
- `three.module.js` source: `package/build/three.module.js`
- `controls/OrbitControls.js` source: `package/examples/jsm/controls/OrbitControls.js`
- Rewrite: OrbitControls' bare `three` import is `../three.module.js`.
- Vendored SHA-256: `three.module.js` `ce1fa418de16a19495a9f72495580e3015d7745c296d3ce0485897f902ddedfb`
- Vendored SHA-256: `controls/OrbitControls.js` `89ccfb99469a7bc628c67a457be6c2f740d7dbb44b0c239258b4e54effac79c1`

## three-mesh-bvh 0.8.3

- Tarball: https://registry.npmjs.org/three-mesh-bvh/-/three-mesh-bvh-0.8.3.tgz
- npm integrity: `sha512-4G5lBaF+g2auKX3P0yqx+MJC6oVt6sB5k+CchS6Ob0qvH0YIhuUk1eYr7ktsIpY+albCqE80/FVQGV190PmiAg==`
- `three-mesh-bvh.module.js` source: `package/build/index.module.js`
- Rewrite: the build's bare `three` import is `./three.module.js`.
- Vendored SHA-256: `df48113f61231ee4dacc1ba603f1c491705db77b2eab28a3cdfd34a576acb6ca`

The upstream packages are MIT licensed. Exact upstream files before the import-only rewrites had
SHA-256 `80efaade…c07f4e` (OrbitControls) and `336aec44…9b70` (three-mesh-bvh).
