import * as THREE from 'three';

/**
 * The look of the goo.
 *
 * The base is a physical material with high transmission, so three renders the
 * scene behind it into the transmission pass and refracts it through the mesh —
 * that is what makes it read as a real translucent body rather than a tinted
 * ball. Attenuation gives it depth: thin edges are almost clear, the middle
 * soaks the light into green.
 *
 * On top of that, two injections:
 *   - internal flow, a cheap layered-sine field advected through the body, so
 *     the goo looks like it is slowly moving inside itself;
 *   - a fresnel rim, which is what sells jello — the wet, bright edge you get
 *     where you look through the most material.
 *
 * `fill` (0..1) tracks how much goo the blob has left: a nearly empty blob gets
 * thinner, paler and less lively than a fat one.
 */
export function createGooMaterial(options = {}) {
  const {
    color = 0x8fe022,
    deep = 0x2f7a06,
    rim = 0xd6ff7a,
    // On weak hardware transmission is dropped entirely (it costs a second
    // render of the scene) and the body falls back to plain alpha.
    transmission = 0.94,
    opacity = 1,
  } = options;

  const material = new THREE.MeshPhysicalMaterial({
    color: new THREE.Color(color),
    roughness: 0.07,
    metalness: 0,
    transmission,
    thickness: 1.5,
    ior: 1.34,
    attenuationColor: new THREE.Color(deep),
    attenuationDistance: 3.6,
    clearcoat: 1,
    clearcoatRoughness: 0.05,
    sheen: 1,
    sheenRoughness: 0.35,
    sheenColor: new THREE.Color(rim),
    specularIntensity: 1,
    iridescence: 0.18,
    iridescenceIOR: 1.25,
    emissive: new THREE.Color(0x0a1a02),
    emissiveIntensity: 1,
    transparent: true,
    opacity,
  });

  const uniforms = {
    uTime: { value: 0 },
    uFill: { value: 1 },
    uRimColor: { value: new THREE.Color(rim) },
    uDeepColor: { value: new THREE.Color(deep) },
    uWobble: { value: 0 },
    // Without transmission the body reads flat, so lean harder on the rim.
    uRimBoost: { value: transmission > 0 ? 1 : 1.7 },
  };
  material.userData.uniforms = uniforms;

  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);

    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
        varying vec3 vGooLocal;`
      )
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
        vGooLocal = transformed;`
      );

    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
        uniform float uTime;
        uniform float uFill;
        uniform float uWobble;
        uniform float uRimBoost;
        uniform vec3 uRimColor;
        uniform vec3 uDeepColor;
        varying vec3 vGooLocal;

        // Layered sines advected in time: cheap, smooth, and it never tiles
        // visibly on a body this small.
        float gooFlow(vec3 p) {
          float a = sin(p.x * 1.7 + uTime * 0.7) * sin(p.y * 2.1 - uTime * 0.5) * sin(p.z * 1.9 + uTime * 0.6);
          float b = sin(p.x * 3.3 - uTime * 0.9) * sin(p.y * 3.9 + uTime * 0.8) * sin(p.z * 3.1 - uTime * 0.7);
          float c = sin(length(p) * 5.0 - uTime * 1.6);
          return a * 0.55 + b * 0.3 + c * 0.15;
        }`
      )
      .replace(
        '#include <map_fragment>',
        `#include <map_fragment>
        float flow = gooFlow(vGooLocal * 1.15);
        // Denser streaks inside a full blob; a drained one goes pale and watery.
        diffuseColor.rgb = mix(diffuseColor.rgb, uDeepColor, smoothstep(0.15, 0.95, flow) * 0.35 * uFill);
        diffuseColor.rgb += flow * 0.05 * uFill;`
      )
      .replace(
        '#include <emissivemap_fragment>',
        `#include <emissivemap_fragment>
        vec3 gooView = normalize(vViewPosition);
        float fresnel = pow(1.0 - saturate(dot(gooView, normal)), 3.0);
        float shimmer = 0.5 + 0.5 * gooFlow(vGooLocal * 2.3 + vec3(0.0, uTime * 0.35, 0.0));
        // Wet rim, brighter the more goo there is and the harder it just got hit.
        totalEmissiveRadiance += uRimColor * fresnel * (0.26 + 0.38 * uFill) * (0.75 + 0.45 * shimmer) * uRimBoost;
        totalEmissiveRadiance += uRimColor * uWobble * fresnel * 0.9;`
      );
  };

  // Any change to the injected code needs a fresh program.
  material.customProgramCacheKey = () => 'goo-material-v1';
  return material;
}
