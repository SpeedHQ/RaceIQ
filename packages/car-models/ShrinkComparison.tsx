import { useEffect, useRef } from "react";
import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { MeshoptDecoder } from "meshoptimizer";

function release(scene: THREE.Object3D) {
  const resources = new Set<THREE.BufferGeometry | THREE.Material | THREE.Texture>();
  scene.traverse((object) => {
    if (!(object instanceof THREE.Mesh)) return;
    resources.add(object.geometry);
    for (const material of Array.isArray(object.material) ? object.material : [object.material]) {
      resources.add(material);
      for (const value of Object.values(material)) if (value instanceof THREE.Texture) resources.add(value);
    }
  });
  for (const resource of resources) {
    if (resource instanceof THREE.Texture && typeof ImageBitmap !== "undefined" && resource.image instanceof ImageBitmap) resource.image.close();
    resource.dispose();
  }
}

export function ShrinkComparison({ source, output, label, onReady }: { source: Blob; output: Blob; label: string; onReady: (ok: boolean) => void }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    if (!canvas.current) return;
    const element = canvas.current;
    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({ canvas: element, alpha: true, antialias: true });
    } catch {
      onReady(false);
      return;
    }
    const loader = new GLTFLoader().setMeshoptDecoder(MeshoptDecoder);
    const scenes = [new THREE.Scene(), new THREE.Scene()];
    const camera = new THREE.PerspectiveCamera(36, 1, 0.001, 10000);
    const centre = new THREE.Vector3();
    let radius = 1,
      closed = false;
    const draw = () => {
      const width = element.clientWidth,
        height = element.clientHeight;
      if (!width || !height) return;
      renderer.setSize(width, height, false);
      camera.aspect = Math.floor(width / 2) / height;
      const distance = (radius * 1.15) / Math.sin(Math.min(Math.atan(camera.aspect * Math.tan(Math.PI / 10)), Math.PI / 10));
      camera.near = distance / 1000;
      camera.far = distance * 10;
      camera.position.set(1, 0.65, 1).normalize().multiplyScalar(distance).add(centre);
      camera.lookAt(centre);
      camera.updateProjectionMatrix();
      renderer.setScissorTest(true);
      scenes.forEach((scene, index) => {
        const w = Math.floor(width / 2);
        renderer.setViewport(index * w, 0, w, height);
        renderer.setScissor(index * w, 0, w, height);
        renderer.render(scene, camera);
      });
    };
    const observer = new ResizeObserver(draw);
    observer.observe(element);
    Promise.all(
      [source, output].map(async (blob, i) => {
        const gltf = await loader.parseAsync(await blob.arrayBuffer(), "");
        if (closed) {
          release(gltf.scene);
          return;
        }
        const scene = scenes[i]!;
        scene.add(gltf.scene, new THREE.HemisphereLight(0xffffff, 0xa0a0a0, 2));
        const light = new THREE.DirectionalLight(0xffffff, 2);
        light.position.set(2, 5, 3);
        scene.add(light);
        if (i === 0) {
          const sphere = new THREE.Box3().setFromObject(gltf.scene).getBoundingSphere(new THREE.Sphere());
          centre.copy(sphere.center);
          radius = Math.max(0.001, sphere.radius);
        }
      }),
    )
      .then(() => {
        if (!closed) {
          draw();
          onReady(true);
        }
      })
      .catch(() => {
        if (!closed) onReady(false);
      });
    return () => {
      closed = true;
      observer.disconnect();
      scenes.forEach(release);
      renderer.dispose();
    };
  }, [source, output, onReady]);
  return <canvas ref={canvas} aria-label={label} className="block h-48 w-full bg-app-bg sm:h-64" />;
}
