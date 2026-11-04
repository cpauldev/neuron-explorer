import * as THREE from "three";
import { LineMaterial } from "three/addons/lines/LineMaterial.js";
import { LineSegmentsGeometry } from "three/addons/lines/LineSegmentsGeometry.js";

export const LAYER_GAP = 1.9;

export function glowPoints(
  sizePx,
  maxScale = 3,
  ambient = false,
  ring = false,
) {
  return new THREE.RawShaderMaterial({
    uniforms: {
      size: { value: sizePx * Math.min(devicePixelRatio, 2) },
      ref: { value: 1 },
      maxScale: { value: maxScale },
      contextMute: { value: 0 },
      contextColor: { value: new THREE.Color("#94a3b8") },
      opacity: { value: 1 },
      focusX: { value: 0 },
      fadeW: { value: 1 },
      fadeAmt: { value: 0 },
      camSide: { value: 1 },
      tdist: { value: 1 },
      focused: { value: 0 },
      network: { value: 0 },
      idleColor: { value: new THREE.Color() },
      isolate: { value: 0 },
      ambient: { value: ambient ? 1 : 0 },
      ring: { value: ring ? 1 : 0 },
    },
    vertexShader: `precision highp float;
      uniform mat4 modelViewMatrix, projectionMatrix;
      uniform float size, ref, maxScale, focusX, fadeW, fadeAmt, camSide, tdist, ambient, isolate, network, focused;
      uniform vec3 idleColor, contextColor; uniform float contextMute, opacity;
      attribute vec3 position; attribute vec3 color; attribute float pointOpacity; varying vec3 vC; varying float vAlpha;
      void main() {
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        gl_Position = projectionMatrix * mv;
        float d = (position.x - focusX) / fadeW;
        float front = step(0.45, (position.x - focusX) * camSide / ${LAYER_GAP.toFixed(3)});
        float keep = mix(1.0, exp(-d * d), fadeAmt * 0.92) * mix(1.0, 0.12, front * fadeAmt);
        keep *= mix(1.0, 1.0 - step(0.1, abs(position.x - focusX)), isolate);
        float close = 1.0 - smoothstep(0.12, 0.85, tdist / max(ref, 0.001));
        float sc = clamp(sqrt(ref / max(-mv.z, 0.01)), 0.65, maxScale);
        vC = mix(color, contextColor, contextMute);
        float signal = smoothstep(0.025, 0.08, distance(color, idleColor));
        float contextAlpha = mix(mix(0.075, 0.28, close), mix(0.03, 0.16, close), focused);
        float detailAlpha = mix(contextAlpha, 0.72, max(isolate, signal));
        vAlpha = mix(0.98, detailAlpha * keep, ambient) * pointOpacity * mix(1.0, mix(0.16, 0.8, close), network);
        vAlpha *= opacity * mix(1.0, 0.22, contextMute);
        gl_PointSize = size * sc;
      }`,
    fragmentShader: `precision highp float;
      varying vec3 vC; varying float vAlpha; uniform float ring;
      #include <colorspace_pars_fragment>
      void main() {
        float r = length(gl_PointCoord - 0.5);
        if (r > 0.5) discard;
        float edge = 1.0 - smoothstep(0.28, 0.5, r);
        gl_FragColor = sRGBTransferOETF(vec4(clamp(vC, 0.0, 1.0), edge * vAlpha * mix(1.0, smoothstep(0.25, 0.34, r), ring)));
      }`,
    defaultAttributeValues: { pointOpacity: [1] },
    transparent: true,
    depthWrite: false,
    blending: THREE.NormalBlending,
  });
}

export function connectionMaterial(width) {
  const material = new LineMaterial({
    vertexColors: true,
    linewidth: width,
    transparent: true,
    depthWrite: false,
    depthTest: false,
    blending: THREE.NormalBlending,
  });
  material.vertexShader =
    "attribute float instanceOpacity; varying float vLinkOpacity;\n" +
    material.vertexShader.replace(
      "void main() {",
      "void main() { vLinkOpacity = instanceOpacity;",
    );
  material.uniforms.contextMute = { value: 0 };
  material.uniforms.contextColor = { value: new THREE.Color("#94a3b8") };
  material.fragmentShader =
    "uniform float contextMute; uniform vec3 contextColor; varying float vLinkOpacity;\n" +
    material.fragmentShader.replace(
      "gl_FragColor = vec4( diffuseColor.rgb, alpha );",
      "gl_FragColor = vec4( mix(diffuseColor.rgb, contextColor, contextMute), alpha * vLinkOpacity * mix(1.0, 0.22, contextMute) );",
    );
  return material;
}

export function setLineSegments(lines, positions, colors, opacity) {
  lines.geometry.dispose();
  lines.geometry = new LineSegmentsGeometry()
    .setPositions(positions)
    .setColors(colors);
  lines.geometry.setAttribute(
    "instanceOpacity",
    new THREE.InstancedBufferAttribute(new Float32Array(opacity), 1),
  );
  lines.visible = opacity.length > 0;
}

export function setContextMute(material, amount, color) {
  material.uniforms.contextMute.value = amount;
  material.uniforms.contextColor.value.copy(color);
}
