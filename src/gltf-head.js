/**
 * gltf-head.js — адаптер внешней glTF/GLB-модели с ARKit-blendshapes под тот же риг-интерфейс.
 *
 * Подходят: Ready Player Me (?morphTargets=ARKit), VRoid / VRM с perfect-sync, Apple/three.js facecap.glb,
 * MetaHuman-экспорт с ремапом, любая модель, где морфы названы как ARKit (eyeBlinkLeft / eyeBlink_L / EyeBlinkLeft ...).
 *
 *   await head.loadModel('https://models.readyplayer.me/<id>.glb?morphTargets=ARKit,Oculus%20Visemes');
 *   await head.loadModel(url, { mapping: { jawOpen: 'MouthOpen' }, fit: true });
 *
 * Требует importmap с "three/addons/" (см. index.html). Загружается лениво, ядро от него не зависит.
 */
import * as THREE from 'three';
import { CHANNELS } from './emotions.js';

const norm = (s) => String(s).split('.').pop().toLowerCase().replace(/[_\-\s]/g, '').replace(/left$/, 'l').replace(/right$/, 'r');

export class GLTFHead {
  /**
   * @param {string} url
   * @param {object} o  { mapping, fit=true, renderer, rotation:[x,y,z], scale, offset:[x,y,z] }
   */
  static async load(url, o = {}) {
    const { GLTFLoader } = await import('three/addons/loaders/GLTFLoader.js');
    const loader = new GLTFLoader();
    try {
      const { MeshoptDecoder } = await import('three/addons/libs/meshopt_decoder.module.js');
      loader.setMeshoptDecoder(MeshoptDecoder);
    } catch (e) { /* не обязательно */ }
    if (o.renderer) {
      try {
        const { KTX2Loader } = await import('three/addons/loaders/KTX2Loader.js');
        const ktx2 = new KTX2Loader().setTranscoderPath(o.transcoderPath || `https://cdn.jsdelivr.net/npm/three@0.${THREE.REVISION}.0/examples/jsm/libs/basis/`).detectSupport(o.renderer);
        loader.setKTX2Loader(ktx2);
      } catch (e) { /* не обязательно */ }
    }
    const gltf = await loader.loadAsync(url);
    return new GLTFHead(gltf, o);
  }

  constructor(gltf, o = {}) {
    this.object3D = new THREE.Group();
    this.object3D.name = 'GLTFHead';
    this.pivot = new THREE.Group();
    this.object3D.add(this.pivot);
    const model = gltf.scene;
    if (o.rotation) model.rotation.set(...o.rotation);
    this.pivot.add(model);
    this.model = model;

    // morph-меши и карта channel → индекс
    this.targets = [];
    const custom = {};
    for (const ch in o.mapping || {}) custom[norm(o.mapping[ch])] = ch;
    model.traverse((m) => {
      if (m.isMesh) { m.castShadow = m.receiveShadow = true; m.frustumCulled = false; }
      if (!m.isMesh || !m.morphTargetDictionary) return;
      const map = [];
      for (const name in m.morphTargetDictionary) {
        const n = norm(name);
        const ch = custom[n] || GLTFHead.CHANNEL_BY_NORM[n];
        if (ch) map.push([ch, m.morphTargetDictionary[name]]);
      }
      if (map.length) this.targets.push({ mesh: m, map });
    });
    this.hasEyeMorphs = this.targets.some((t) => t.map.some(([c]) => c.startsWith('eyeLook')));

    // кости
    model.traverse((b) => {
      if (!b.isBone && !b.isObject3D) return;
      const n = b.name.toLowerCase();
      if (!this.headBone && /(^|[^a-z])head$/.test(n)) this.headBone = b;
      if (!this.eyeL && /(lefteye|eyeleft|eye_l$|eyel$|eye\.l$)/.test(n)) this.eyeL = b;
      if (!this.eyeR && /(righteye|eyeright|eye_r$|eyer$|eye\.r$)/.test(n)) this.eyeR = b;
    });
    for (const b of [this.headBone, this.eyeL, this.eyeR]) if (b) b.userData.rest = b.quaternion.clone();

    if (o.fit !== false) this._fit(o);
    this._q = new THREE.Quaternion();
    this._e = new THREE.Euler(0, 0, 0, 'YXZ');
    this._ch = {};
  }

  /** Масштабируем и ставим так, чтобы голова совпала с процедурной (макушка ≈ 1, шея ≈ -0.72). */
  _fit(o) {
    this.object3D.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(this.model);
    const size = box.getSize(new THREE.Vector3());
    let s, anchor;
    if (this.headBone) {
      anchor = this.headBone.getWorldPosition(new THREE.Vector3());
      s = 1.72 / Math.max(1e-6, box.max.y - anchor.y);
      this.model.scale.multiplyScalar(s);
      this.model.position.set(-anchor.x * s, -anchor.y * s, -anchor.z * s);
      this.pivot.position.set(0, -0.72, -0.1);
      this.headBoneDrives = true;
    } else {
      s = 2.1 / Math.max(1e-6, size.y);
      const c = box.getCenter(new THREE.Vector3());
      this.model.scale.multiplyScalar(s);
      this.model.position.set(-c.x * s, -c.y * s, -c.z * s);
      this.pivot.position.set(0, -0.1, 0);
    }
    if (o.scale) this.object3D.scale.setScalar(o.scale);
    if (o.offset) this.object3D.position.set(...o.offset);
  }

  update(ch, pose) {
    const c = this._ch;
    Object.assign(c, ch);
    // если у модели нет костей глаз — водим взгляд через eyeLook*-морфы
    if (!this.eyeL && this.hasEyeMorphs) {
      const yaw = pose.eyeYaw / 0.6, pitch = pose.eyePitch / 0.45;
      c.eyeLookOutLeft = Math.max(0, yaw); c.eyeLookInLeft = Math.max(0, -yaw);
      c.eyeLookInRight = Math.max(0, yaw); c.eyeLookOutRight = Math.max(0, -yaw);
      c.eyeLookUpLeft = c.eyeLookUpRight = Math.max(0, pitch);
      c.eyeLookDownLeft = c.eyeLookDownRight = Math.max(0, -pitch);
    }
    for (const t of this.targets) for (const [name, i] of t.map) t.mesh.morphTargetInfluences[i] = c[name] || 0;

    this._e.set(pose.pitch, pose.yaw, pose.roll);
    if (this.headBone) this.headBone.quaternion.copy(this.headBone.userData.rest).multiply(this._q.setFromEuler(this._e));
    else this.pivot.rotation.copy(this._e);
    for (const eye of [this.eyeL, this.eyeR]) {
      if (!eye) continue;
      this._e.set(-pose.eyePitch, pose.eyeYaw, 0);
      eye.quaternion.copy(eye.userData.rest).multiply(this._q.setFromEuler(this._e));
    }
    this.object3D.position.y = (pose.breath || 0) * 0.01;
  }

  dispose() {
    this.object3D.removeFromParent();
    this.object3D.traverse((m) => {
      if (!m.isMesh) return;
      m.geometry.dispose();
      for (const mat of [].concat(m.material)) { for (const k in mat) if (mat[k]?.isTexture) mat[k].dispose(); mat.dispose(); }
    });
  }
}

// нормализованное имя морфа → ARKit-канал
GLTFHead.CHANNEL_BY_NORM = Object.fromEntries(CHANNELS.map((c) => [norm(c), c]));
