import { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { createCarBody, type CarBodyInstance } from "@raceiq/scene-3d/wireframe/CarBody";
import { createAnalysisWheels } from "@raceiq/scene-3d/wireframe/AnalysisWheels";
import { disposeWheelResource, updateWheelResource } from "@raceiq/scene-3d/wireframe/Wheel";
import type { Model } from "./library";

export function FitPreview({ model, view, onReady, label, errorLabel }: { model: Model; view: "top" | "side" | "front"; onReady: (ok: boolean) => void; label: string; errorLabel: string }) {
  const host = useRef<HTMLCanvasElement>(null);
  const current = useRef({ model, view });
  current.current = { model, view };
  const draw = useRef<() => void>(() => {});
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    if (!host.current) return;
    let renderer: THREE.WebGLRenderer;
    setFailed(false);
    onReady(false);
    try {
      renderer = new THREE.WebGLRenderer({ canvas: host.current, antialias: true, alpha: true });
    } catch {
      setFailed(true);
      return;
    }
    const scene = new THREE.Scene();
    scene.add(new THREE.HemisphereLight(0xffffff, 0x909090, 2));
    const light = new THREE.DirectionalLight(0xffffff, 2);
    light.position.set(4, 7, 3);
    scene.add(light);
    const camera = new THREE.OrthographicCamera();
    const geometry = new THREE.SphereGeometry(0.09, 12, 8);
    const color = getComputedStyle(host.current).color;
    const material = new THREE.MeshBasicMaterial({ color, depthTest: false });
    const markers = Array.from({ length: 4 }, () => new THREE.Mesh(geometry, material));
    const arrow = new THREE.ArrowHelper(new THREE.Vector3(1, 0, 0), new THREE.Vector3(), 0.7, material.color, 0.24, 0.2);
    for (const item of [arrow.line, arrow.cone]) {
      (item.material as THREE.Material).depthTest = false;
      item.renderOrder = 2;
    }
    for (const marker of markers) marker.renderOrder = 2;
    scene.add(...markers, arrow);
    const wheels = createAnalysisWheels(scene, current.current.model);
    wheels.forEach((wheel, index) => updateWheelResource(wheel, {
      position: [0, 0, 0], steerAngle: 0, rimColor: color, temperatureReadings: [],
      temperatureThresholds: { cold: 0, warm: 0, hot: 0 }, brakeTemp: 0,
      side: index % 2 ? "right" : "left", isRear: index >= 2, onCurb: false, puddleDepth: 0,
    }));
    let body: CarBodyInstance | undefined,
      disposed = false;
    draw.current = () => {
      const { model: m, view } = current.current;
      const canvas = renderer.domElement;
      const width = canvas.clientWidth,
        height = canvas.clientHeight;
      if (!width || !height) return;
      renderer.setSize(width, height, false);
      const span = Math.max(3, ((m.bodyLength + 1) * height) / width, (m.halfWheelbase * 2 * height) / width + 1, m.halfFrontTrack * 2 + 1, m.halfRearTrack * 2 + 1);
      camera.left = (-span * width) / height / 2;
      camera.right = -camera.left;
      camera.top = span / 2;
      camera.bottom = -camera.top;
      camera.near = 0.1;
      camera.far = 100;
      camera.position.set(view === "front" ? 15 : 0, view === "top" ? 15 : 0, view === "side" ? 15 : 0);
      camera.up.set(0, view === "top" ? 0 : 1, view === "top" ? -1 : 0);
      camera.lookAt(0, 0, 0);
      camera.updateProjectionMatrix();
      markers.forEach((marker, i) => {
        marker.position.set(i < 2 ? m.halfWheelbase : -m.halfWheelbase, 0, (i % 2 ? 1 : -1) * (i < 2 ? m.halfFrontTrack : m.halfRearTrack));
        wheels[i]!.root.position.copy(marker.position);
      });
      arrow.position.set(m.halfWheelbase, 0, 0);
      body?.setFit(m.bodyFit);
      renderer.render(scene, camera);
    };
    const resize = new ResizeObserver(() => draw.current());
    resize.observe(host.current);
    const initial = current.current.model;
    void createCarBody(initial, "solid", initial.glbOffsetX ?? 0, true)
      .then((result) => {
        if (disposed) {
          result.dispose();
          return;
        }
        body = result;
        scene.add(body.root);
        draw.current();
        onReady(true);
      })
      .catch(() => {
        if (!disposed) setFailed(true);
      });
    return () => {
      disposed = true;
      draw.current = () => {};
      resize.disconnect();
      body?.dispose();
      wheels.forEach(disposeWheelResource);
      geometry.dispose();
      material.dispose();
      arrow.dispose();
      renderer.dispose();
    };
  }, [model.modelPath, onReady]);
  useEffect(() => {
    draw.current();
  }, [model, view]);
  return (
    <>
      <canvas ref={host} aria-label={label} className="h-48 w-full bg-app-bg text-app-accent" />
      {failed && <p role="alert">{errorLabel}</p>}
    </>
  );
}
